# Dashboard SNA Fakultas Universitas Indonesia

Dashboard eksplorasi Social Network Analysis (SNA) antar-fakultas UI, dibangun dari hasil
preprocessing data monitoring media (`data/*.json`). Dashboard ini murni HTML/CSS/JS
(tanpa backend) dan membaca file JSON secara langsung menggunakan `fetch()`.

## Cara menjalankan

Karena browser membatasi `fetch()` terhadap file lokal (`file://`), dashboard **harus**
dijalankan melalui local web server, bukan dibuka langsung dari File Explorer/Finder.

1. Buka terminal di folder `ui_sna_dashboard/`.
2. Jalankan salah satu perintah berikut:

   ```bash
   # Python 3
   python -m http.server 8000
   ```

   atau

   ```bash
   # Node.js (jika terinstal http-server)
   npx http-server -p 8000
   ```

3. Buka browser ke:

   ```text
   http://localhost:8000
   ```

## Struktur folder

```text
ui_sna_dashboard/
├── index.html          # struktur halaman dashboard
├── style.css            # styling (mengikuti referensi mockup)
├── app.js                # logika: load data, graph, filter, tabel, metrik
├── README.md
├── .nojekyll             # supaya GitHub Pages tidak memproses folder data/ lewat Jekyll
└── data/
    ├── faculties.json                      # metadata 16 fakultas
    ├── nodes.json                            # node fakultas/akun/link + metrik
    ├── records.json                          # 909 record monitoring mentah (hasil preprocessing)
    ├── monitoring.json                       # 909 baris dari monitoring_clean.xlsx (mentions/engagement/reach/sentimen per tanggal & fakultas)
    ├── edges_shared_account.json             # bipartite faculty–account
    ├── edges_shared_account_projection.json  # projection faculty–faculty (shared account)
    ├── edges_shared_link.json                # bipartite faculty–link
    ├── edges_shared_link_projection.json     # projection faculty–faculty (shared link)
    ├── edges_interaction.json                # kosong (lihat catatan di bawah)
    ├── metrics.json                          # ringkasan metrik dataset
    └── validation_report.json                # hasil validasi pipeline
```

## Catatan penting tentang data

- **Tidak ada angka yang di-hard-code** di JavaScript. Semua KPI, metrik network, dan
  tabel dihitung/dibaca langsung dari file JSON di atas saat halaman dimuat.
- **Interaction network** (`edges_interaction.json`) kosong pada dataset ini. Dashboard
  menampilkannya sebagai *"No interaction data available"* dan **tidak** memperlakukan
  shared-account sebagai bentuk interaksi.
- **Shared Account** dan **Shared Link** adalah dua jenis jejaring yang berbeda maknanya
  dan ditampilkan terpisah lewat tab selector — tidak pernah digabung secara default.
- Satu konten/link **boleh** muncul di beberapa fakultas — ini disengaja dan menjadi dasar
  pembentukan shared-link network, sehingga tidak dideduplikasi lintas fakultas.
- Centrality (degree/betweenness/closeness) adalah ukuran **struktural** dalam graf
  (dihitung dari graf yang sedang aktif sesuai tab & filter), **bukan** ukuran kualitas,
  performa, atau "kepentingan" fakultas secara absolut.

## Deploy ke GitHub Pages

Dashboard ini 100% statis (HTML/CSS/JS + JSON), jadi tidak perlu build step apa pun.

1. Buat repository baru di GitHub, lalu push seluruh isi folder `ui_sna_dashboard/`
   (termasuk folder `data/` dan file `.nojekyll`) ke branch `main`:

   ```bash
   git init
   git add .
   git commit -m "Initial commit: SNA dashboard"
   git branch -M main
   git remote add origin https://github.com/<username>/<repo>.git
   git push -u origin main
   ```

2. Di GitHub: **Settings → Pages → Build and deployment → Source**, pilih
   **Deploy from a branch**, branch **main**, folder **/ (root)**. Simpan.
3. Tunggu beberapa saat, lalu dashboard akan tersedia di:

   ```text
   https://<username>.github.io/<repo>/
   ```

Catatan:
- File `.nojekyll` sudah disertakan supaya GitHub Pages tidak memproses folder
  `data/` lewat Jekyll (yang bisa mengganggu file JSON).
- Semua path data memakai path relatif (`data/....json`), jadi tetap berfungsi
  baik di `localhost` maupun di subpath GitHub Pages (`/<repo>/`).
- Karena GitHub Pages hanya bisa menyajikan file statis, seluruh perhitungan
  (KPI, network metrics, sentimen) tetap dihitung di browser lewat `app.js`
  seperti saat dijalankan lokal.

## Fitur

- **Executive Summary** (baru): Total Mentions, Engagement, Estimasi Reach, Sentimen
  Positif — dihitung langsung dari `monitoring.json` (hasil ekspor `monitoring_clean.xlsx`),
  mengikuti filter **Periode** (tanggal) dan **Fakultas** di kanan atas header.
- KPI cards ringkasan dataset (Total Records, Unique Contents, Unique Accounts,
  Number of Faculties, Shared Account/Link Connections)
- Network graph interaktif (D3.js force-directed): zoom, pan, drag node, hover tooltip,
  klik node/edge, highlight koneksi, legend
- Selector Shared Account vs Shared Link
- Filter: faculty (multi-select), minimum shared items (slider), search box
- Panel detail fakultas (degree, weighted degree, jumlah akun/link/record/content,
  **total mentions & breakdown sentimen positif/netral/negatif** dari `monitoring.json`
  sesuai periode aktif, daftar koneksi)
- Panel detail koneksi (jumlah shared items + daftar akun/link, URL dapat diklik)
- Network metrics (nodes, edges, density, avg degree, avg weighted degree, degree/betweenness/closeness centrality)
- Tabel hubungan fakultas: sortable, searchable, pagination
- Bagian Data & Methodology dan Validation Report
- Responsive layout
