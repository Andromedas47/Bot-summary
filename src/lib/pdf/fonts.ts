import path from "path";
import { Font } from "@react-pdf/renderer";

let registered = false;

function fontPath(filename: string): string {
  return path.join(process.cwd(), "public", "fonts", filename);
}

export function registerFonts() {
  if (registered) return;
  registered = true;

  Font.register({
    family: "SarabunPDF",
    fonts: [
      { src: fontPath("Sarabun-Regular.ttf"), fontWeight: "normal" },
      { src: fontPath("Sarabun-Bold.ttf"),    fontWeight: "bold" },
    ],
  });

  // Prevent hyphenation so Thai words are never broken mid-word
  Font.registerHyphenationCallback((word) => [word]);
}
