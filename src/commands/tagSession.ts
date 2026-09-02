import * as vscode from 'vscode';
import { SessionItem, SessionListProvider } from '../sessionListProvider';
import { MetadataStore } from '../metadataStore';

interface TagPickItem extends vscode.QuickPickItem {
  tagValue: string;
}

const CREATE_NEW_VALUE = '__create_new_tag__';

/**
 * One unified flow to add and remove tags — a multi-select QuickPick over every tag already used
 * in the workspace, pre-checked with whichever ones this session already has, plus an in-flow
 * "create a new tag" entry. Toggling a checkbox on/off is the whole add/remove experience.
 */
async function manageTagsFlow(tagUniverseInit: string[], currentTags: string[], sessionTitle: string): Promise<string[]> {
  let tagUniverse = [...tagUniverseInit];
  let selected = new Set(currentTags);

  for (;;) {
    const items: TagPickItem[] = [
      { label: '$(add) Create a new tag…', tagValue: CREATE_NEW_VALUE },
      ...tagUniverse.map((tag) => ({ label: tag, tagValue: tag, picked: selected.has(tag) })),
    ];

    const qp = vscode.window.createQuickPick<TagPickItem>();
    qp.title = `Manage tags for "${sessionTitle}"`;
    qp.placeholder = 'Toggle tags to apply, or create a new one';
    qp.canSelectMany = true;
    qp.items = items;
    qp.selectedItems = items.filter((i) => selected.has(i.tagValue));

    const outcome = await new Promise<{ accepted: boolean; picks: readonly TagPickItem[] }>((resolve) => {
      qp.onDidAccept(() => resolve({ accepted: true, picks: qp.selectedItems }));
      qp.onDidHide(() => resolve({ accepted: false, picks: [] }));
      qp.show();
    });
    qp.dispose();

    if (!outcome.accepted) {
      return [...selected];
    }

    const pickedCreateNew = outcome.picks.some((p) => p.tagValue === CREATE_NEW_VALUE);
    selected = new Set(outcome.picks.filter((p) => p.tagValue !== CREATE_NEW_VALUE).map((p) => p.tagValue));

    if (!pickedCreateNew) {
      return [...selected];
    }

    const newTag = await vscode.window.showInputBox({ prompt: 'New tag name' });
    if (newTag?.trim()) {
      const trimmed = newTag.trim();
      if (!tagUniverse.includes(trimmed)) {
        tagUniverse = [...tagUniverse, trimmed].sort((a, b) => a.localeCompare(b));
      }
      selected.add(trimmed);
    }
    // loop back and re-show with the updated universe/selection
  }
}

export function registerTagCommands(
  context: vscode.ExtensionContext,
  listProvider: SessionListProvider,
  metadataStore: MetadataStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.manageTags', async (item?: SessionItem) => {
      if (!item) {
        return;
      }
      const allTags = await metadataStore.getAllTags();
      const finalTags = await manageTagsFlow(allTags, item.tags, item.session.title);
      await metadataStore.setTags(item.session.sessionId, finalTags);
      listProvider.refresh();
    }),
  );
}
