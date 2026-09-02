import * as path from 'node:path';
import Mocha from 'mocha';
import { glob } from 'glob';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20000 });
  const testsRoot = __dirname;

  return glob('**/*.test.js', { cwd: testsRoot }).then(
    (files) =>
      new Promise((resolve, reject) => {
        files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));
        try {
          mocha.run((failures) => {
            if (failures > 0) {
              reject(new Error(`${failures} test(s) failed.`));
            } else {
              resolve();
            }
          });
        } catch (err) {
          reject(err);
        }
      }),
  );
}
