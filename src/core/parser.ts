import { readFileSync } from 'node:fs';
import ts from 'typescript';

export function parseFile(filePath: string): ts.SourceFile {
  const content = readFileSync(filePath, 'utf8');
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
}