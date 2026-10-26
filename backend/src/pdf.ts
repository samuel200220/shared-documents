import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const MAX_PDF_BYTES = 4_000_000;

export class PdfGenerationError extends Error {
  readonly code: "PDF_UNSUPPORTED_CHARACTER" | "PDF_TOO_LARGE";

  constructor(code: "PDF_UNSUPPORTED_CHARACTER" | "PDF_TOO_LARGE", message: string) {
    super(message);
    this.name = "PdfGenerationError";
    this.code = code;
  }
}

function assertPdfText(text: string): void {
  // Reject unsupported glyphs rather than silently changing saved document text.
  const winAnsiExtras = new Set([0x20ac, 0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x2122]);
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if ((point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d) ||
        (point > 0x7e && point < 0xa0) ||
        (point > 0xff && !winAnsiExtras.has(point))) {
      throw new PdfGenerationError("PDF_UNSUPPORTED_CHARACTER", "Certains caractères ne sont pas représentables par la police PDF intégrée.");
    }
  }
}

export async function generatePdf(title: string, content: string): Promise<Uint8Array> {
  assertPdfText(`${title}\n${content}`);
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator("Shared Docs Editor");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pageSize = { width: 595.28, height: 841.89 };
  let page = pdf.addPage([pageSize.width, pageSize.height]);
  const margin = 54;
  let y = pageSize.height - margin;
  const drawLine = (line: string, size: number, gap: number) => {
    if (y < margin + gap) { page = pdf.addPage([pageSize.width, pageSize.height]); y = pageSize.height - margin; }
    page.drawText(line, { x: margin, y, size, font, color: rgb(0.12, 0.15, 0.2), maxWidth: pageSize.width - margin * 2 });
    y -= gap;
  };
  drawLine(title, 20, 32);
  y -= 10;
  for (const rawParagraph of content.split(/\r?\n/)) {
    const paragraph = rawParagraph.replace(/\t/g, "    ");
    let line = "";
    let lineWidth = 0;
    const availableWidth = pageSize.width - margin * 2;
    for (const character of Array.from(paragraph)) {
      const characterWidth = font.widthOfTextAtSize(character, 11);
      if (line && lineWidth + characterWidth > availableWidth) {
        drawLine(line, 11, 16);
        line = character;
        lineWidth = characterWidth;
      } else {
        line += character;
        lineWidth += characterWidth;
      }
    }
    if (line) drawLine(line, 11, 16);
    else y -= 16;
    y -= 8;
  }
  const bytes = await pdf.save();
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfGenerationError("PDF_TOO_LARGE", "Le PDF dépasse la limite de téléchargement de 4 Mo.");
  }
  return bytes;
}
