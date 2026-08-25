"""Generate 500 numbered slides as PDF in HD resolution (1920x1080)."""
from reportlab.lib.pagesizes import landscape
from reportlab.pdfgen import canvas
from reportlab.lib.colors import white, black


def create_slides_pdf(output_path: str, num_slides: int = 500):
    """Create a PDF with numbered slides in HD resolution."""
    # HD resolution: 1920x1080 pixels at 72 DPI
    width, height = 1920, 1080

    c = canvas.Canvas(output_path, pagesize=(width, height))

    for i in range(1, num_slides + 1):
        # White background
        c.setFillColor(white)
        c.rect(0, 0, width, height, fill=1, stroke=0)

        # Black text - large centered number
        c.setFillColor(black)
        c.setFont("Helvetica-Bold", 300)

        # Center the number
        text = str(i)
        text_width = c.stringWidth(text, "Helvetica-Bold", 300)
        x = (width - text_width) / 2
        y = (height - 300) / 2 + 100  # Adjust for baseline

        c.drawString(x, y, text)

        # Add page number at bottom
        c.setFont("Helvetica", 24)
        footer = f"Page {i} / {num_slides}"
        footer_width = c.stringWidth(footer, "Helvetica", 24)
        c.drawString((width - footer_width) / 2, 50, footer)

        c.showPage()

        if i % 100 == 0:
            print(f"Generated {i} slides...")

    c.save()
    print(f"PDF saved to {output_path}")


if __name__ == "__main__":
    import sys
    num_slides = int(sys.argv[1]) if len(sys.argv) > 1 else 500
    output_path = f"/Users/ms25/project/WebScreen/test_slides/numbered_slides_1-{num_slides}.pdf"
    create_slides_pdf(output_path, num_slides)
