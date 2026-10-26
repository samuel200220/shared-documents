import assert from "node:assert/strict";
import test from "node:test";
import { generatePdf, PdfGenerationError } from "../src/pdf.js";

test("PDF generation produces an artifact for French text", async () => {
  const bytes = await generatePdf("Compte rendu", "Réunion de l’association.\nDécisions et échéances.");
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(bytes.byteLength > 500);
});

test("PDF generation rejects unrepresentable glyphs without changing saved text", async () => {
  await assert.rejects(
    generatePdf("Notes", "Texte avec emoji 🙂"),
    (error: unknown) => error instanceof PdfGenerationError && error.code === "PDF_UNSUPPORTED_CHARACTER",
  );
});
