/**
  Copyright 2022 Dynatrace LLC

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
 */

import { readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";

export const readTestDataFile = (relativePath: string) => {
  return readFileSync(path.resolve(__dirname, "..", "unit", "test_data", relativePath)).toString();
};

export const mockExistsSync = (mockFs: jest.Mocked<typeof fs>, items: string[]) => {
  mockFs.existsSync.mockImplementation(p => {
    return items.includes(p.toString());
  });
};

export const mockReadFileSync = (mockFs: jest.Mocked<typeof fs>, items: [string, string][]) => {
  mockFs.existsSync.mockImplementation(p => {
    return items.find(i => i[0] === p.toString()) !== undefined;
  });
  mockFs.readFileSync.mockImplementation(p => {
    const item = items.find(i => i[0] === p.toString());
    if (item) {
      return item[1];
    }
    throw new Error("File not found");
  });
};
