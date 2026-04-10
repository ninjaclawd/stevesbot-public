import json
import sys
from PIL import Image, ImageOps


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("usage: resize_image.py <input> <output> <max_width> <max_height>")

    input_path, output_path, max_width_raw, max_height_raw = sys.argv[1:5]
    max_width = max(int(max_width_raw), 1)
    max_height = max(int(max_height_raw), 1)

    with Image.open(input_path) as image:
        image = ImageOps.exif_transpose(image)
        original_width, original_height = image.size
        image.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        image.save(output_path, format="PNG", optimize=True)
        width, height = image.size

    print(
        json.dumps(
            {
                "width": width,
                "height": height,
                "originalWidth": original_width,
                "originalHeight": original_height,
            }
        )
    )


if __name__ == "__main__":
    main()
