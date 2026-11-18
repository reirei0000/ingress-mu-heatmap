# Ingress Global S2 Level-13 MU Density Heatmap

Interactive global heatmap of S2 Cell Mind Unit (MU) densities (Levels 6, 8, and 13), covering **all 83,811,572 populated S2 Level-13 cells worldwide** in a static, serverless package (~185 MB total across 231 binary shards).

---

## Features

- **Multi-Resolution Global Rendering (HTML5 Canvas)**:
  - **Zoom 2–6**: Global S2 Level-6 overview heatmap (6,726 cells)
  - **Zoom 7–10**: Regional S2 Level-8 heatmap (91,131 cells)
  - **Zoom 11–18**: Full S2 Level-13 street-level heatmap (83.8 million cells worldwide), dynamically streaming only the visible S2 Level-3 binary shard (`data/l13/s_<l3>.bin`) and unpacking in browser memory via `DecompressionStream("gzip")`.
- **Close-Up MU Labels (`Zoom >= 16`)**:
  - Displays the exact MU density number at the center of each S2 Level-13 cell.
- **Top 30 High-Density Pins**:
  - Automatically highlights the Top 30 highest MU-density cells in the current viewport (Rank 1–10: Red, 11–20: Orange, 21–30: Blue).
- **12-Step & 6-Step Color Palettes**:
  - Includes a detailed 12-step palette (`0 / 100 / 250 / 500 / 1k / 2k / 3.5k / 5k / 6.5k / 8k / 10k / 12k+`) to distinguish both rural/suburban gradients and high-density urban cores.
- **Bilingual UI**:
  - English (default) and Japanese (`[日本語]` / `[English]` toggle button or `?lang=ja`).

---

## Data Source, Attribution & Citation

### 1. Population Data (GRUMP v1)
The MU density values displayed on this map are derived from the year-2000 UN-adjusted population count grids of the **Global Rural-Urban Mapping Project, Version 1 (GRUMPv1)**, sampled at S2 Level-15 cell centers with a half-pixel northwest shift.

> **Required Citation:**
> Center for International Earth Science Information Network (CIESIN), Columbia University; International Food Policy Research Institute (IFPRI); The World Bank; and Centro Internacional de Agricultura Tropical (CIAT). 2011. *Global Rural-Urban Mapping Project, Version 1 (GRUMPv1): Population Count Grid*. Palisades, NY: NASA Socioeconomic Data and Applications Center (SEDAC). [https://doi.org/10.7927/H4VT1Q1H](https://doi.org/10.7927/H4VT1Q1H).

Please consult the [NASA Earthdata / SEDAC collection use constraints](https://cmr.earthdata.nasa.gov/search/concepts/C3540929345-ESDIS.umm_json) regarding copyright and terms of use.

### 2. Method & Upstream Reconstruction
- **Calculation Model & Reference Implementation**: [InvestigateXM/Ingress-MU-calculation](https://github.com/InvestigateXM/Ingress-MU-calculation) ([https://mu.investigatexm.com](https://mu.investigatexm.com))
- **Prior Work**: Gordon Ludlow, [Reverse Engineering MU](https://gordonludlow.com/ingress/reverse-engineering-mu/)
- This is an independent empirical reconstruction and is not affiliated with or endorsed by Niantic Spatial.

---

## Publishing on GitHub Pages

The entire `s2map/` directory (~185 MB) fits well within GitHub Pages' 1 GB site limit (and each shard in `data/l13/s_*.bin` is 0.1–3.2 MB, well below the 100 MB per-file limit).

1. Create a new GitHub repository (e.g., `ingress-s2-mu-map`) and push the contents of `s2map/` (`index.html`, `README.md`, and `data/`):
   ```bash
   cd s2map
   git init
   git add index.html README.md data/
   git commit -m "Add global S2 Level-13 MU density heatmap"
   git branch -M main
   git remote add origin https://github.com/<YOUR_USERNAME>/<YOUR_REPO>.git
   git push -u origin main
   ```
2. On GitHub, open **Settings > Pages**, and under **Build and deployment > Branch**, select **`main`** (folder **`/ (root)`**) and click **Save**.
3. Your global S2 Level-13 MU heatmap will be live at `https://<YOUR_USERNAME>.github.io/<YOUR_REPO>/`.

