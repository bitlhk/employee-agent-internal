import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PptxGenJS = require("pptxgenjs");

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nVQAAAAASUVORK5CYII=";

async function build(output, pageNumber, color) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "EA merge test";
  pptx.defineSlideMaster({
    title: `MASTER_${pageNumber}`,
    background: { color: "F7F8FA" },
    objects: [
      {
        text: {
          text: `PAGE ${pageNumber}`,
          options: {
            x: 11.3,
            y: 7.05,
            w: 1.4,
            h: 0.2,
            fontFace: "DejaVu Sans",
            fontSize: 9,
            bold: true,
            color,
            align: "right",
            margin: 0,
          },
        },
      },
    ],
  });
  const slide = pptx.addSlide(`MASTER_${pageNumber}`);
  slide.addText(`Fixture ${pageNumber}`, {
    x: 0.7,
    y: 0.6,
    w: 4,
    h: 0.5,
    fontFace: "DejaVu Sans",
    fontSize: 28,
    bold: true,
    color,
  });
  slide.addImage({ data: pixel, x: 0.8, y: 1.5, w: 1, h: 1 });
  slide.addChart(
    "bar",
    [{ name: "Series", labels: ["A", "B"], values: [pageNumber, pageNumber + 1] }],
    {
      x: 2.2,
      y: 1.5,
      w: 5.4,
      h: 3.5,
      showLegend: false,
      showTitle: false,
      chartColors: [color],
    },
  );
  await pptx.writeFile({ fileName: output });
}

Promise.all([
  build(process.argv[2], 1, "147D92"),
  build(process.argv[3], 2, "B42318"),
]).catch((error) => {
  console.error(error);
  process.exit(1);
});
