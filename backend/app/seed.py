"""One-shot seeder: (re)creates the schema and loads backend/data/seed.json."""

import json
from datetime import date
from pathlib import Path

from app.db import Base, SessionLocal, engine
from app.models import Customer, Order

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def seed() -> None:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    payload = json.loads((DATA_DIR / "seed.json").read_text())

    with SessionLocal() as db:
        for c in payload["customers"]:
            db.add(Customer(id=c["id"], name=c["name"], email=c["email"]))
        for o in payload["orders"]:
            db.add(
                Order(
                    id=o["id"],
                    customer_id=o["customer_id"],
                    product=o["product"],
                    amount=o["amount"],
                    order_date=date.fromisoformat(o["order_date"]),
                    status=o["status"],
                )
            )
        db.commit()

    print(
        f"Seeded {len(payload['customers'])} customers and "
        f"{len(payload['orders'])} orders into {engine.url}"
    )


if __name__ == "__main__":
    seed()
