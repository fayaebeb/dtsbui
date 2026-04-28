import os
import shutil
import struct
import zipfile
from typing import BinaryIO, Optional, Union


_LOCAL_FILE_HEADER = b"PK\x03\x04"
_LOCAL_HEADER = struct.Struct("<IHHHHHIIIHH")
_ZIP32_WRAP = 1 << 32
_FIRST_OFFSET_ATTR = "_dtsb_first_header_offset"


def _zip_size(zf: zipfile.ZipFile) -> Optional[int]:
    fp = zf.fp
    if fp is None:
        return None
    pos = fp.tell()
    try:
        fp.seek(0, os.SEEK_END)
        return fp.tell()
    except OSError:
        return None
    finally:
        fp.seek(pos)


def _local_header_name_at(zf: zipfile.ZipFile, offset: int) -> Optional[str]:
    if offset < 0 or zf.fp is None:
        return None

    fp = zf.fp
    pos = fp.tell()
    try:
        fp.seek(offset)
        header = fp.read(_LOCAL_HEADER.size)
        if len(header) != _LOCAL_HEADER.size or header[:4] != _LOCAL_FILE_HEADER:
            return None

        fields = _LOCAL_HEADER.unpack(header)
        flags = fields[2]
        name_len = fields[9]
        name_bytes = fp.read(name_len)
        encoding = "utf-8" if flags & 0x800 else "cp437"
        return name_bytes.decode(encoding)
    except (OSError, UnicodeDecodeError, struct.error):
        return None
    finally:
        fp.seek(pos)


def _first_header_offset(zf: zipfile.ZipFile) -> int:
    cached = getattr(zf, _FIRST_OFFSET_ATTR, None)
    if isinstance(cached, int):
        return cached

    try:
        first_offset = int(zf.infolist()[0].header_offset)
    except (IndexError, TypeError, ValueError):
        first_offset = 0
    setattr(zf, _FIRST_OFFSET_ATTR, first_offset)
    return first_offset


def _candidate_offsets(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> list[int]:
    first_offset = _first_header_offset(zf)

    bases = [info.header_offset]
    if first_offset:
        bases.append(info.header_offset - first_offset)

    for base in list(bases):
        bases.extend([base + _ZIP32_WRAP, base - _ZIP32_WRAP])

    seen: set[int] = set()
    offsets: list[int] = []
    for offset in bases:
        if not isinstance(offset, int) or offset < 0 or offset in seen:
            continue
        seen.add(offset)
        offsets.append(offset)

    size = _zip_size(zf)
    if size is None:
        return offsets
    return [offset for offset in offsets if offset + _LOCAL_HEADER.size <= size]


def _repair_member_offset(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> bool:
    wanted = info.filename.replace("\\", "/")
    for offset in _candidate_offsets(zf, info):
        found = _local_header_name_at(zf, offset)
        if found and found.replace("\\", "/") == wanted:
            info.header_offset = offset
            return True
    return False


def open_zip_member(
    zf: zipfile.ZipFile,
    member: Union[str, zipfile.ZipInfo],
) -> BinaryIO:
    info = zf.getinfo(member) if isinstance(member, str) else member
    try:
        return zf.open(info)
    except zipfile.BadZipFile as exc:
        if "Bad magic number for file header" not in str(exc):
            raise
        if not _repair_member_offset(zf, info):
            raise
        return zf.open(info)


def extract_zip_member(zf: zipfile.ZipFile, member: str, dest_dir: str) -> str:
    dst = os.path.join(dest_dir, os.path.basename(member))
    with open_zip_member(zf, member) as src, open(dst, "wb") as dst_file:
        shutil.copyfileobj(src, dst_file, length=1024 * 1024)
    return dst
