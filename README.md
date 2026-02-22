# Endfield Map Tool

## Demo: [Click Me](xci9.github.io/Endfield-Map-Tool/)

**Endfield Map Tool** is a web-based tool designed for *Arknights: Endfield*. It automatically locates and stitches gameplay screenshots onto the larger world map using computer vision techniques.

This tool simplifies the process of creating complete map composites by analyzing screenshot features and finding their exact position and scale on the base map.

## How to Use

1. **Select Map**: Choose the target region (e.g., "Originium Zone 04" or "Wuling") from the toolbar.
2. **Upload Screenshot**:
   - Drag and drop an image file into the drop zone.
   - Or paste an image from your clipboard (Ctrl+V).
   - Or click "Select Screenshot".
3. **Crop Image**:
   - A crop window will appear.
   - Adjust the selection to **exclude game UI elements** (buttons, mini-maps, HP bars) as these interfere with recognition.
   - Click "Confirm Crop".
4. **Auto-Stitching**:
   - The tool will analyze the image and place it on the base map.
   - Success status and similarity score will be displayed.
5. **Download**:
   - Click "Download Full Map" to save the merged result.
   - Transparent areas around the map are automatically trimmed.


## Tips for Best Results

- **Remove UI**: Always crop out static UI elements (menus, character portraits) before confirming. The algorithm looks for map terrain features.
- **Overlap**: Ensure your new screenshot has some overlap with known areas of the base map or previous screenshots if you are building out from a known point (though currently, it strictly matches against the base map).
- **Resolution**: Higher resolution screenshots generally yield better results, but processing time may increase.

## License

This project is licensed under the [GNU General Public License v2.0](LICENSE).

## Copyright Notice and Disclaimer

**1. Source Code License**
The source code of this project is licensed under the **GNU General Public License v2.0 (GPLv2)**. You are free to use, modify, and distribute the code under the terms of this license.

**2. Game Assets Disclaimer**
This project contains game assets (including but not limited to images, maps, icons...) from *Arknights: Endfield*.
- All rights to these assets belong to **Gryphline** and **Hypergryph**.
- These assets are used here for educational and fan community purposes only.
- The GPLv2 license **does not** extend to these proprietary assets.
- If you redistribute this project, you must ensure that your use of these assets complies with the copyright holder's policies. You may not use these assets for commercial purposes without explicit permission from the rights holders.

---
*Disclaimer: This is a fan-made tool and is not affiliated with, endorsed, sponsored, or specifically approved by Arknights: Endfield or Gryphline.*
