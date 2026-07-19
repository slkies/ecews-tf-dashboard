#!/usr/bin/env python3
"""
Convert the ECEWS workbook into a zip of Parquet files.

    python scripts/to_parquet.py July_11_Line_List.xlsx

Produces July_11_Line_List.parquet.zip, which you upload instead of the .xlsx.

Why bother:
  - roughly 10x smaller, so the upload is quick even on a bad connection
  - ~20x faster to parse server-side
  - it carries dtypes. S/N stays TEXT. This is the real reason: the values need
    12+ decimal places to stay unique, and any round-trip that treats them as a
    number collides clients and silently breaks every join. Excel does exactly
    that if anyone opens the file and saves it.

Run this once per cycle, on the machine that produces the export, and the
workbook never has to travel at all.
"""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

import pandas as pd

KEY = "S/N"


def _to_parquet_bytes(df: pd.DataFrame) -> bytes:
    """
    Parquet needs one type per column. The EMR writes mixed content into object
    columns - the 'bp' column, for instance, holds both strings and datetimes -
    and pyarrow refuses those outright.

    Anything ambiguous becomes text. That loses nothing: ingestion re-parses
    every date and number with to_datetime/to_numeric regardless, and text is
    exactly what we want for S/N anyway.
    """
    out = df.copy()
    for c in out.columns:
        if out[c].dtype == "object":
            out[c] = out[c].map(lambda v: None if pd.isna(v) else str(v)).astype("string")
    return out.to_parquet(index=False, compression="snappy")


def convert(src: Path) -> Path:
    dst = src.with_suffix(".parquet.zip")
    xls = pd.ExcelFile(src)
    print(f"{src.name}  ({src.stat().st_size / 1e6:.1f} MB)\n")

    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        for sheet in xls.sheet_names:
            df = xls.parse(sheet, dtype={KEY: "string"})

            if KEY in df.columns:
                # Belt and braces: force text, and prove we did not lose precision.
                df[KEY] = df[KEY].astype("string").str.strip()
                n_uniq = df[KEY].nunique()
                n_rows = int(df[KEY].notna().sum())
                if n_uniq < n_rows:
                    print(f"  !! {sheet}: {n_rows - n_uniq} duplicate keys - "
                          f"check the export, joins will be wrong")

            buf = _to_parquet_bytes(df)
            z.writestr(f"{sheet}.parquet", buf)
            print(f"  {sheet:<34} {len(df):>7,} rows x {len(df.columns):>3} cols")

    before, after = src.stat().st_size, dst.stat().st_size
    print(f"\n{dst.name}  ({after / 1e6:.1f} MB)  -  {before / after:.1f}x smaller")
    print("Upload this file on the Admin tab.")
    return dst


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python scripts/to_parquet.py <workbook.xlsx>")
    src = Path(sys.argv[1])
    if not src.exists():
        sys.exit(f"not found: {src}")
    convert(src)
