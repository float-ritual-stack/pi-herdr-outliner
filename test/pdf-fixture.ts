const encoder = new TextEncoder();

export interface PdfFixturePage {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly {
    readonly text: string;
    readonly x: number;
    readonly y: number;
    readonly size?: number;
  }[];
}

function escapedPdfText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function streamObject(content: string): string {
  const length = encoder.encode(content).byteLength;
  return `<< /Length ${length} >>\nstream\n${content}\nendstream`;
}

export function createPdfFixture(pages: readonly PdfFixturePage[]): Uint8Array {
  if (pages.length === 0) throw new Error("PDF fixture requires at least one page");
  const pageObjectIds = pages.map((_, index) => 3 + index * 2);
  const fontObjectId = 3 + pages.length * 2;
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    const pageObjectId = pageObjectIds[index]!;
    const contentObjectId = pageObjectId + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
    );
    objects.push(streamObject(page.lines.map((line) =>
      `BT /F1 ${line.size ?? 14} Tf ${line.x} ${line.y} Td (${escapedPdfText(line.text)}) Tj ET`
    ).join("\n")));
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(encoder.encode(pdf).byteLength);
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = encoder.encode(pdf).byteLength;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(pdf);
}
