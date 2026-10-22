export interface BundleSection {
  /** Ruta tal como aparece en el paquete (relativa al directorio raíz, con `/`). */
  path: string;
  content: string;
  /** Línea (1-based) del paquete donde empieza el contenido de la sección. */
  firstLine: number;
}

const HEADER_PATTERN = /^\/\/ ===== FILE: (.+?)(?: \[trimmed: [^\]]*\])? =====$/;

export function formatSectionHeader(displayPath: string, note: string): string {
  return `// ===== FILE: ${displayPath}${note} =====`;
}

/** Separa un paquete de contexto en sus secciones. Ignora todo lo anterior a la primera. */
export function parseBundle(text: string): BundleSection[] {
  const sections: Array<{ path: string; lines: string[]; firstLine: number }> = [];
  let current: { path: string; lines: string[]; firstLine: number } | undefined;

  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, index) => {
      const path = HEADER_PATTERN.exec(line)?.[1];
      if (path !== undefined) {
        current = { path, lines: [], firstLine: index + 2 };
        sections.push(current);
        return;
      }
      current?.lines.push(line);
    });

  return sections.map((section) => ({
    path: section.path,
    content: section.lines.join('\n').trimEnd(),
    firstLine: section.firstLine,
  }));
}