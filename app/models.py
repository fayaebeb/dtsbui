import os
import sqlite3
import uuid
from datetime import datetime
from typing import Optional, Dict, Any, List

from flask import current_app
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash


def get_db():
    path = current_app.config["DB_PATH"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_blob_column(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(simulations)")
    cols = [row[1] for row in cur.fetchall()]
    if "blob_name" not in cols:
        cur.execute("ALTER TABLE simulations ADD COLUMN blob_name TEXT")
        conn.commit()


def init_db(app=None):
    from flask import current_app as flask_current

    cfg_app = app or flask_current
    path = cfg_app.config["DB_PATH"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS simulations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            size INTEGER,
            uploaded_at TEXT NOT NULL,
            uploaded_by TEXT,
            published INTEGER DEFAULT 0,
            cached_json_path TEXT,
            blob_name TEXT
        );
        """
    )
    conn.commit()
    _ensure_blob_column(conn)
    conn.close()


class User(UserMixin):
    def __init__(self, id: int, username: str, password_hash: str, created_at: str):
        self.id = id
        self.username = username
        self.password_hash = password_hash
        self.created_at = created_at

    @staticmethod
    def get_by_username(username: str) -> Optional["User"]:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT * FROM users WHERE username=?", (username,))
        row = cur.fetchone()
        conn.close()
        if row:
            return User(row["id"], row["username"], row["password_hash"], row["created_at"])
        return None

    @staticmethod
    def get_by_id(user_id: int) -> Optional["User"]:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT * FROM users WHERE id=?", (user_id,))
        row = cur.fetchone()
        conn.close()
        if row:
            return User(row["id"], row["username"], row["password_hash"], row["created_at"])
        return None

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)


def create_admin_if_missing(app, username: str, password: str) -> bool:
    """Returns True if created, False if exists."""
    init_db(app)
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM users WHERE username=?", (username,))
    if cur.fetchone():
        conn.close()
        return False
    ph = generate_password_hash(password)
    cur.execute(
        "INSERT INTO users(username, password_hash, created_at) VALUES(?,?,?)",
        (username, ph, datetime.utcnow().isoformat()),
    )
    conn.commit()
    conn.close()
    return True


def insert_simulation(name: str, path: str, size: int, uploaded_by: str, blob_name: Optional[str] = None) -> Dict[str, Any]:
    sim_id = str(uuid.uuid4())
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO simulations(id, name, path, size, uploaded_at, uploaded_by, published, blob_name)
        VALUES(?,?,?,?,?,?,0,?)
        """,
        (sim_id, name, path, size, datetime.utcnow().isoformat(), uploaded_by, blob_name),
    )
    conn.commit()
    cur.execute("SELECT * FROM simulations WHERE id=?", (sim_id,))
    row = cur.fetchone()
    conn.close()
    return dict(row)


def insert_simulation_with_id(
    sim_id: str,
    name: str,
    path: str,
    size: int,
    uploaded_by: str,
    published: int = 0,
    blob_name: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Insert a simulation row using a caller-provided sim_id (e.g., when the folder is already
    created under uploads/<sim_id>). Returns the inserted row as a dict.
    """
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO simulations(id, name, path, size, uploaded_at, uploaded_by, published, blob_name)
        VALUES(?,?,?,?,?,?,?,?)
        """,
        (sim_id, name, path, size, datetime.utcnow().isoformat(), uploaded_by, published, blob_name),
    )
    conn.commit()
    cur.execute("SELECT * FROM simulations WHERE id=?", (sim_id,))
    row = cur.fetchone()
    conn.close()
    return dict(row)


def list_simulations(all_rows: bool = True) -> List[Dict[str, Any]]:
    conn = get_db()
    cur = conn.cursor()
    if all_rows:
        cur.execute("SELECT * FROM simulations ORDER BY uploaded_at DESC")
    else:
        cur.execute("SELECT * FROM simulations WHERE published=1 ORDER BY uploaded_at DESC")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def get_simulation(sim_id: str) -> Optional[Dict[str, Any]]:
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM simulations WHERE id=?", (sim_id,))
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else None


def update_simulation(sim_id: str, **kwargs) -> Optional[Dict[str, Any]]:
    if not kwargs:
        return get_simulation(sim_id)
    fields = ",".join([f"{k}=?" for k in kwargs.keys()])
    values = list(kwargs.values()) + [sim_id]
    conn = get_db()
    cur = conn.cursor()
    cur.execute(f"UPDATE simulations SET {fields} WHERE id=?", values)
    conn.commit()
    cur.execute("SELECT * FROM simulations WHERE id=?", (sim_id,))
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else None


def delete_simulation(sim_id: str) -> bool:
    sim = get_simulation(sim_id)
    if not sim:
        return False
    conn = get_db()
    cur = conn.cursor()
    cur.execute("DELETE FROM simulations WHERE id=?", (sim_id,))
    conn.commit()
    conn.close()
    return True
