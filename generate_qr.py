import qrcode
from PIL import Image, ImageDraw
import os

def create_qr_with_logo():
    url = "https://mobile.locapay.app/"
    logo_path = "/Users/macbookpro/Documents/BACKEND APPS/MY LOCA/LOCAPAY-NEST-JS/upload/logoIcon.png"
    output_path = "locapay_qr.png"

    # Generate QR code
    qr = qrcode.QRCode(
        version=5, # Higher version for better error correction capacity
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=12,
        border=1, # Minimum border to avoid white space around
    )
    qr.add_data(url)
    qr.make(fit=True)

    img_qr = qr.make_image(fill_color="black", back_color="white").convert('RGBA')

    # Open and process logo
    if os.path.exists(logo_path):
        logo = Image.open(logo_path).convert("RGBA")
        
        # Resize logo - very small as requested
        # Making it about 15% of the QR code width
        basewidth = int(img_qr.size[0] * 0.15)
        wpercent = (basewidth / float(logo.size[0]))
        hsize = int((float(logo.size[1]) * float(wpercent)))
        logo = logo.resize((basewidth, hsize), Image.Resampling.LANCZOS if hasattr(Image, 'Resampling') else Image.LANCZOS)

        # Create rounded borders mask
        mask = Image.new('L', logo.size, 0)
        draw = ImageDraw.Draw(mask)
        radius = int(basewidth / 8) # roundness
        
        # Polyfill for rounded_rectangle if not available
        if hasattr(draw, 'rounded_rectangle'):
            draw.rounded_rectangle((0, 0, basewidth, hsize), radius, fill=255)
        else:
            draw.rectangle((radius, 0, basewidth - radius, hsize), fill=255)
            draw.rectangle((0, radius, basewidth, hsize - radius), fill=255)
            draw.pieslice((0, 0, radius * 2, radius * 2), 180, 270, fill=255)
            draw.pieslice((basewidth - radius * 2, 0, basewidth, radius * 2), 270, 360, fill=255)
            draw.pieslice((0, hsize - radius * 2, radius * 2, hsize), 90, 180, fill=255)
            draw.pieslice((basewidth - radius * 2, hsize - radius * 2, basewidth, hsize), 0, 90, fill=255)

        # Apply mask
        logo_rounded = Image.new('RGBA', logo.size)
        logo_rounded.paste(logo, (0, 0), mask)

        # Calculate position for logo
        pos = ((img_qr.size[0] - logo.size[0]) // 2, (img_qr.size[1] - logo.size[1]) // 2)

        # Draw a white background behind the logo for better scanning
        white_bg = Image.new('RGBA', logo.size, 'white')
        img_qr.paste(white_bg, pos, mask)
        
        # Paste rounded logo
        img_qr.paste(logo_rounded, pos, logo_rounded)

    # Save directly without any extra text or padding
    img_qr.save(output_path)
    print(f"QR code successfully generated at {os.path.abspath(output_path)}")

if __name__ == "__main__":
    create_qr_with_logo()
