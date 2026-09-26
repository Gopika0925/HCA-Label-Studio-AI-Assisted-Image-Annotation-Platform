# HCA Label Studio — Human-in-the-Loop Image Labelling Tool

> An AI-assisted, browser-based image annotation tool with bounding-box editing, MySQL storage, and simulated CNN retraining.

---

## Folder Structure

```
hca/
├── app.py                  ← Flask server (main entry point)
├── requirements.txt
├── README.md
├── templates/
│   └── index.html          ← Single-page app (Jinja2 template)
├── static/
│   ├── style.css           ← Dark glassmorphism UI
│   └── script.js           ← Canvas interaction + Fetch API
├── uploads/                ← Auto-created; stores uploaded images
├── annotations/            ← Auto-created; stores JSON annotation files
└── logs/                   ← Auto-created; stores app.log
```

---

## Prerequisites

| Tool | Version |
|------|---------|
| Python | 3.9 – 3.12 |
| MySQL Server | 8.0+ |
| pip | latest |

---

## Quick Start

### 1 — Clone / open the project folder

```bash
cd "path/to/hca"
```

### 2 — Create a virtual environment (recommended)

```bash
python -m venv venv
venv\Scripts\activate      # Windows
# source venv/bin/activate # macOS / Linux
```

### 3 — Install dependencies

```bash
pip install -r requirements.txt
```

> **Note:** TensorFlow (~500 MB) will be downloaded the first time.  
> The app also downloads the MobileNetV2 ImageNet weights (~14 MB) on first prediction.

### 4 — Configure MySQL

Edit the `DB_CONFIG` block near the top of `app.py`:

```python
DB_CONFIG = {
    "host":     "localhost",
    "port":     3306,
    "user":     "root",        # ← your MySQL user
    "password": "password",    # ← your MySQL password
    "database": "hca_labels",  # ← will be created automatically
}
```

> The app will create the `hca_labels` database and both tables automatically on startup.  
> If MySQL is not running, the app still works — annotations are saved as JSON files only.

### 5 — Run the server

```bash
python app.py
```

Open **http://localhost:5000** in your browser.

---

## MySQL Schema (created automatically)

```sql
CREATE TABLE annotations (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    image_name    VARCHAR(255),
    label         VARCHAR(100),
    x             INT,
    y             INT,
    width         INT,
    height        INT,
    confidence    FLOAT,
    reviewed_by   VARCHAR(100),
    timestamp     DATETIME
);

CREATE TABLE correction_log (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    image_name      VARCHAR(255),
    original_label  VARCHAR(100),
    corrected_label VARCHAR(100),
    reviewed_by     VARCHAR(100),
    timestamp       DATETIME
);
```

---

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/` | Serve the web app |
| POST | `/upload` | Upload image + get AI prediction |
| POST | `/save_annotation` | Save annotation (JSON + MySQL) |
| GET | `/annotations` | List all saved annotations |
| POST | `/retrain` | Simulate model retraining |
| GET | `/health` | Server health check |
| GET | `/uploads/<filename>` | Serve uploaded image |

---

## Features

- **AI Pre-labelling** using MobileNetV2 (ImageNet pretrained)
- **Interactive Canvas** — move, resize (8 handles), relabel, delete, and draw new boxes
- **Human Correction Logging** — tracks when a human changes the AI label
- **MySQL + JSON dual storage** — works without MySQL too
- **Retrain simulation** — `/retrain` endpoint ready to hook into a real training job
- **Dark glassmorphism UI** — Inter font, animated upload zone, toast notifications
