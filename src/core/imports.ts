import ts from 'typescript';

/**
 * Devuelve todos los specifiers de imports estáticos, re-exports e import() dinámicos
 * con string literal. Decidir cuáles son locales (relativos, alias de paths, paquetes
 * del workspace) es trabajo del resolver, no de este módulo.
 */
export function extractModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const found = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [firstArg] = node.arguments;
      if (firstArg !== undefined && ts.isStringLiteralLike(firstArg)) found.add(firstArg.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...found];
}