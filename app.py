"""
app.py — Flask Backend for Human-in-the-Loop Image Labelling Tool
=================================================================
Provides:
  - Image upload endpoint
  - AI-based prediction using a dummy CNN (TensorFlow)
  - MySQL-backed annotation storage
  - Correction logging
  - Dummy /retrain endpoint
"""

import os
import io
import json
import uuid
import logging
import datetime

from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_cors import CORS
import mysql.connector
import numpy as np

# ── YOLOv8 (multi-object detection) ─────────────────────────────────────────
try:
    from ultralytics import YOLO
    YOLO_AVAILABLE = True
except ImportError:
    YOLO_AVAILABLE = False

# ══════════════════════════════════════════════════════════════════════════════
# Flask App Initialisation
# ══════════════════════════════════════════════════════════════════════════════
app = Flask(__name__)
CORS(app)  # Allow cross-origin requests from the frontend

# ── Directory Setup ───────────────────────────────────────────────────────────
BASE_DIR        = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER   = os.path.join(BASE_DIR, "uploads")
ANNOTATION_DIR  = os.path.join(BASE_DIR, "annotations")
LOG_DIR         = os.path.join(BASE_DIR, "logs")

for d in [UPLOAD_FOLDER, ANNOTATION_DIR, LOG_DIR]:
    os.makedirs(d, exist_ok=True)

app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "bmp", "webp"}

# ── Logging Setup ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(os.path.join(LOG_DIR, "app.log")),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)

# ══════════════════════════════════════════════════════════════════════════════
# MySQL Configuration  ← Edit these values to match your MySQL server
# ══════════════════════════════════════════════════════════════════════════════
DB_CONFIG = {
    "host":     os.getenv("MYSQL_HOST", "localhost"),
    "port":     int(os.getenv("MYSQL_PORT", "3306")),
    "user":     os.getenv("MYSQL_USER", "root"),
    "password": os.getenv("MYSQL_PASSWORD", "password"),
    "database": os.getenv("MYSQL_DATABASE", "hca_labels"),
}


def get_db_connection():
    """Return a live MySQL connection, or None if unavailable."""
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        return conn
    except mysql.connector.Error as err:
        logger.warning(f"MySQL connection failed: {err}. Annotations will be JSON-only.")
        return None


def init_db():
    """Create the database and annotations table if they don't exist."""
    try:
        # Connect without specifying a DB first so we can CREATE DATABASE
        cfg = {k: v for k, v in DB_CONFIG.items() if k != "database"}
        conn = mysql.connector.connect(**cfg)
        cursor = conn.cursor()
        cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{DB_CONFIG['database']}`")
        cursor.execute(f"USE `{DB_CONFIG['database']}`")
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS annotations (
                id            INT AUTO_INCREMENT PRIMARY KEY,
                image_name    VARCHAR(255)    NOT NULL,
                label         VARCHAR(100),
                x             INT,
                y             INT,
                width         INT,
                height        INT,
                confidence    FLOAT,
                reviewed_by   VARCHAR(100),
                timestamp     DATETIME
            )
        """)
        # Table for logging user corrections
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS correction_log (
                id            INT AUTO_INCREMENT PRIMARY KEY,
                image_name    VARCHAR(255),
                original_label  VARCHAR(100),
                corrected_label VARCHAR(100),
                reviewed_by   VARCHAR(100),
                timestamp     DATETIME
            )
        """)
        conn.commit()
        conn.close()
        logger.info("Database initialised successfully.")
    except mysql.connector.Error as err:
        logger.warning(f"DB init failed (MySQL may not be running): {err}")


# ══════════════════════════════════════════════════════════════════════════════
# AI Model — MobileNetV2 (pretrained on ImageNet)
# ══════════════════════════════════════════════════════════════════════════════
logger.info("Loading YOLOv8n model …")
if YOLO_AVAILABLE:
    try:
        # yolov8n is the nano (fastest) variant — downloads ~6 MB on first run
        MODEL = YOLO("yolov8n.pt")
        logger.info("YOLOv8n model loaded successfully.")
    except Exception as e:
        logger.warning(f"Could not load YOLOv8: {e}. Falling back to dummy.")
        MODEL = None
else:
    logger.warning("ultralytics not installed. Using dummy predictions.")
    MODEL = None


def predict_image(img_path: str) -> list:
    """
    Run YOLOv8 on a saved image file.
    Returns a LIST of detections:
      [ { label, confidence, bbox: {x, y, width, height} }, ... ]
    Falls back to random dummy detections if the model isn't available.
    """
    try:
        if MODEL is None:
            raise RuntimeError("Model not available")

        results = MODEL.predict(img_path, verbose=False, conf=0.25)[0]
        detections = []
        for box in results.boxes:
            cls_id = int(box.cls[0])
            label  = results.names[cls_id].replace("_", " ").title()
            conf   = round(float(box.conf[0]), 4)
            # box.xywh → [cx, cy, w, h] in pixels; convert to top-left x,y
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            detections.append({
                "label":      label,
                "confidence": conf,
                "bbox": {
                    "x":      int(x1),
                    "y":      int(y1),
                    "width":  int(x2 - x1),
                    "height": int(y2 - y1),
                },
            })

        if not detections:
            # Model ran but found nothing — return a low-confidence placeholder
            detections.append({
                "label": "No objects detected",
                "confidence": 0.0,
                "bbox": {"x": 10, "y": 10, "width": 50, "height": 50},
            })
        logger.info(f"YOLO detected {len(detections)} object(s): {[d['label'] for d in detections]}")
        return detections

    except Exception as e:
        logger.warning(f"Detection fallback triggered: {e}")
        # Dummy fallback — returns 3 random objects so the UI always works
        dummy_labels = ["Person", "Dog", "Car", "Bird", "Bicycle", "Chair", "Laptop", "Cat"]
        return [
            {
                "label":      np.random.choice(dummy_labels),
                "confidence": round(float(np.random.uniform(0.55, 0.95)), 4),
                "bbox": {
                    "x":      int(np.random.randint(10, 100)),
                    "y":      int(np.random.randint(10, 100)),
                    "width":  int(np.random.randint(80, 200)),
                    "height": int(np.random.randint(80, 200)),
                },
            }
            for _ in range(3)
        ]


# ══════════════════════════════════════════════════════════════════════════════
# Helper Utilities
# ══════════════════════════════════════════════════════════════════════════════
def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# ══════════════════════════════════════════════════════════════════════════════
# Routes
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/")
def index():
    """Serve the main HTML page."""
    return render_template("index.html")


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    """Serve uploaded images so the browser can display them."""
    return send_from_directory(UPLOAD_FOLDER, filename)


# ── Upload & Predict ──────────────────────────────────────────────────────────
@app.route("/upload", methods=["POST"])
def upload_image():
    """
    POST /upload
    Accepts multipart/form-data with key 'image'.
    Saves the file, runs YOLOv8, and returns:
      { filename, image_url, detections: [ { label, confidence, bbox }, ... ] }
    """
    if "image" not in request.files:
        return jsonify({"error": "No image file provided"}), 400

    file = request.files["image"]
    if file.filename == "":
        return jsonify({"error": "Empty filename"}), 400

    if not allowed_file(file.filename):
        return jsonify({"error": "File type not allowed"}), 400

    # Build a unique filename to avoid collisions
    ext       = file.filename.rsplit(".", 1)[1].lower()
    unique    = f"{uuid.uuid4().hex}.{ext}"
    save_path = os.path.join(UPLOAD_FOLDER, unique)
    file.save(save_path)
    logger.info(f"Image saved: {unique}")

    detections = predict_image(save_path)
    logger.info(f"Detections for {unique}: {len(detections)} object(s)")

    return jsonify({
        "filename":   unique,
        "image_url":  f"/uploads/{unique}",
        "detections": detections,
    })


# ── Save Annotation ───────────────────────────────────────────────────────────
@app.route("/save_annotation", methods=["POST"])
def save_annotation():
    """
    POST /save_annotation
    Body (JSON): {
        image_name, reviewed_by, original_label,
        annotations: [ { label, x, y, width, height, confidence }, … ]
    }
    Saves to MySQL (if available) and to /annotations/<image_name>.json.
    Also logs corrections when reviewed label != original AI label.
    """
    data = request.get_json(force=True)
    if not data:
        return jsonify({"error": "No JSON body"}), 400

    image_name    = data.get("image_name", "unknown.jpg")
    reviewed_by   = data.get("reviewed_by", "anonymous")
    original_label = data.get("original_label", "")
    annotations   = data.get("annotations", [])
    ts            = datetime.datetime.now()

    # ── Write JSON to disk ────────────────────────────────────────────────────
    ann_file = os.path.join(ANNOTATION_DIR, f"{image_name}.json")
    payload  = {
        "image_name":  image_name,
        "reviewed_by": reviewed_by,
        "timestamp":   ts.isoformat(),
        "annotations": annotations,
    }
    with open(ann_file, "w") as f:
        json.dump(payload, f, indent=2)
    logger.info(f"Annotation JSON saved: {ann_file}")

    # ── Insert into MySQL ─────────────────────────────────────────────────────
    conn = get_db_connection()
    inserted = 0
    if conn:
        cursor = conn.cursor()
        try:
            for ann in annotations:
                cursor.execute("""
                    INSERT INTO annotations
                        (image_name, label, x, y, width, height, confidence, reviewed_by, timestamp)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    image_name,
                    ann.get("label", ""),
                    ann.get("x", 0),
                    ann.get("y", 0),
                    ann.get("width", 0),
                    ann.get("height", 0),
                    ann.get("confidence", 0.0),
                    reviewed_by,
                    ts,
                ))
                inserted += 1

            # Log corrections if human overrode the AI label
            for ann in annotations:
                if ann.get("label", "") != original_label and original_label:
                    cursor.execute("""
                        INSERT INTO correction_log
                            (image_name, original_label, corrected_label, reviewed_by, timestamp)
                        VALUES (%s, %s, %s, %s, %s)
                    """, (image_name, original_label, ann.get("label", ""), reviewed_by, ts))

            conn.commit()
        except mysql.connector.Error as err:
            conn.rollback()
            logger.error(f"MySQL insert error: {err}")
        finally:
            conn.close()

    return jsonify({
        "status":   "saved",
        "file":     ann_file,
        "db_rows":  inserted,
        "message":  "Annotation saved successfully!",
    })


# ── List Annotations ──────────────────────────────────────────────────────────
@app.route("/annotations", methods=["GET"])
def list_annotations():
    """Return all annotation JSON files stored on disk."""
    results = []
    for fname in os.listdir(ANNOTATION_DIR):
        if fname.endswith(".json"):
            with open(os.path.join(ANNOTATION_DIR, fname)) as f:
                results.append(json.load(f))
    return jsonify(results)


# ── Retrain ───────────────────────────────────────────────────────────────────
@app.route("/retrain", methods=["POST"])
def retrain():
    """
    POST /retrain
    Simulates a retraining cycle.  In a real system this would kick off
    a training job using the saved annotations as labelled ground truth.
    """
    ann_files = [f for f in os.listdir(ANNOTATION_DIR) if f.endswith(".json")]
    logger.info(f"[RETRAIN] Simulating retraining on {len(ann_files)} annotation(s) …")

    # Dummy delay / simulation
    import time
    time.sleep(1)

    return jsonify({
        "status":   "success",
        "message":  f"Model retrained (simulated) on {len(ann_files)} annotation(s).",
        "accuracy": round(float(np.random.uniform(0.82, 0.97)), 4),
    })


# ── Health Check ──────────────────────────────────────────────────────────────
@app.route("/health")
def health():
    model_name = "yolov8" if (MODEL and YOLO_AVAILABLE) else "dummy"
    return jsonify({"status": "ok", "model": model_name})


# ══════════════════════════════════════════════════════════════════════════════
# Entry Point
# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    init_db()
    logger.info("Starting HCA Label Tool server on http://localhost:5000")
    app.run(debug=True, host="0.0.0.0", port=5000)
