import { parentPort, workerData } from "node:worker_threads";
const MAX_CHARS = 100000;
function bounded(text) {
  if (text.length > MAX_CHARS) throw new Error("This document is too long. Upload a shorter section (up to 100,000 characters).");
  return text;
}
try {
  const buffer = Buffer.from(workerData.data, "base64");
  let text;
  if (workerData.extension === "txt") {
    text = bounded(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    if (/\x00/.test(text)) throw new Error("This TXT file is not readable UTF-8 text.");
  } else if (workerData.extension === "pdf") {
    if (!buffer.subarray(0, 1024).toString("latin1").includes("%PDF-")) throw new Error("This is not a readable PDF.");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, useWorkerFetch: false, disableFontFace: true, verbosity: 0 });
    const pdf = await loading.promise;
    try {
      if (pdf.numPages > 200) throw new Error("Upload a PDF section of 200 pages or fewer.");
      text = "";
      for (let page = 1; page <= pdf.numPages; page++) {
        const content = await (await pdf.getPage(page)).getTextContent();
        text = bounded(text + `\n[Page ${page}]\n` + content.items.map(item => item.str + (item.hasEOL ? "\n" : " ")).join(""));
      }
      if (!text.replace(/\[Page \d+\]/g, "").trim()) throw new Error("This PDF has no readable text. Scanned or image-only documents need OCR first.");
    } finally { await loading.destroy(); }
  } else {
    // Check declared expanded sizes before letting the DOCX parser inflate ZIP entries.
    let entries = 0, expanded = 0, directory = false;
    for (let pos = 0; pos + 46 <= buffer.length; pos++) {
      if (buffer.readUInt32LE(pos) !== 0x02014b50) continue;
      directory = true;
      entries++;
      expanded += buffer.readUInt32LE(pos + 24);
      if (entries > 2000 || expanded > 20 * 1024 * 1024) throw new Error("This DOCX expands beyond the supported size. Upload a smaller section.");
      pos += 45 + buffer.readUInt16LE(pos + 28) + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
    }
    if (!directory) throw new Error("This is not a readable DOCX file.");
    const mammoth = await import("mammoth");
    text = bounded((await mammoth.extractRawText({ buffer })).value);
  }
  if (!text.trim()) throw new Error("This document has no readable text.");
  parentPort.postMessage({ text });
} catch (error) {
  const known = /too long|Upload |This |Scanned/.test(error.message || "");
  parentPort.postMessage({ error: known ? error.message : "The document could not be read. Check that it is not damaged or password protected; TXT files must use UTF-8." });
}
