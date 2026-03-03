import html2canvas from "html2canvas";
import jsPDF from "jspdf";

interface ExportElementToPdfInput {
  element: HTMLElement;
  fileName: string;
}

export async function exportElementToPdf(input: ExportElementToPdfInput): Promise<void> {
  const canvas = await html2canvas(input.element, {
    scale: 2,
    useCORS: true,
    backgroundColor: "#ffffff",
  });

  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 10;
  const printableWidth = pageWidth - margin * 2;
  const printableHeight = pageHeight - margin * 2;

  const sourcePageHeightPx = Math.floor((printableHeight * canvas.width) / printableWidth);
  const pageCanvas = document.createElement("canvas");
  pageCanvas.width = canvas.width;
  pageCanvas.height = sourcePageHeightPx;
  const pageCtx = pageCanvas.getContext("2d");

  if (!pageCtx) {
    throw new Error("Unable to initialize canvas context for PDF export.");
  }

  const totalPages = Math.max(1, Math.ceil(canvas.height / sourcePageHeightPx));

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    const sourceY = pageIndex * sourcePageHeightPx;
    const copyHeight = Math.min(sourcePageHeightPx, canvas.height - sourceY);

    pageCtx.clearRect(0, 0, pageCanvas.width, pageCanvas.height);
    pageCtx.fillStyle = "#ffffff";
    pageCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    pageCtx.drawImage(
      canvas,
      0,
      sourceY,
      pageCanvas.width,
      copyHeight,
      0,
      0,
      pageCanvas.width,
      copyHeight
    );

    const imageData = pageCanvas.toDataURL("image/png");
    const renderHeight = (copyHeight * printableWidth) / canvas.width;

    if (pageIndex > 0) {
      pdf.addPage();
    }
    pdf.addImage(imageData, "PNG", margin, margin, printableWidth, renderHeight, undefined, "FAST");
  }

  pdf.save(input.fileName);
}
