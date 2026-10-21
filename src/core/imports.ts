import ts from 'typescript';


export function isLocalSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/** Devuelve los specifiers locales de imports estáticos, re-exports y import() dinámicos con string literal. */
export function extractLocalSpecifiers(sourceFile: ts.SourceFile): string[] {
  const found = new Set<string>();

  const add = (specifier: string): void => {
    if (isLocalSpecifier(specifier)) found.add(specifier);
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [firstArg] = node.arguments;
      if (firstArg !== undefined && ts.isStringLiteralLike(firstArg)) add(firstArg.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...found];
}