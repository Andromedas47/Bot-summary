import { Font } from "@react-pdf/renderer";

let registered = false;

export function registerFonts() {
  if (registered) return;
  registered = true;

  Font.register({
    family: "Sarabun",
    fonts: [
      {
        src: "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/sarabun/static/Sarabun-Regular.ttf",
        fontWeight: "normal",
      },
      {
        src: "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/sarabun/static/Sarabun-Bold.ttf",
        fontWeight: "bold",
      },
    ],
  });

  // Prevent hyphenation so Thai words are never broken mid-word
  Font.registerHyphenationCallback((word) => [word]);
}
