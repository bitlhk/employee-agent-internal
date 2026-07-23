#!/usr/bin/env python3
"""Merge approved single-slide PPTX files on Linux and verify the result.

The merger imports each slide's complete OOXML dependency graph instead of
copying only ``ppt/slides/slideN.xml``. This preserves page-specific layouts,
masters, themes, media, charts, and embedded objects.
"""

from __future__ import annotations

import argparse
import json
import os
import posixpath
import re
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, unquote
from xml.etree import ElementTree as ET


CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
PACKAGE_RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
DOCUMENT_RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
EXTENDED_PROPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"

REL_BASE = f"{DOCUMENT_RELS_NS}/"
SLIDE_REL_TYPE = f"{REL_BASE}slide"
SLIDE_MASTER_REL_TYPE = f"{REL_BASE}slideMaster"
NOTES_MASTER_REL_TYPE = f"{REL_BASE}notesMaster"

SLIDE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
SLIDE_MASTER_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"
)


def qname(namespace: str, local_name: str) -> str:
    return f"{{{namespace}}}{local_name}"


def serialize_xml(root: ET.Element, default_namespace: str | None = None) -> bytes:
    if default_namespace:
        ET.register_namespace("", default_namespace)
    ET.register_namespace("p", PRESENTATION_NS)
    ET.register_namespace("r", DOCUMENT_RELS_NS)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def normalize_part_name(value: str) -> str:
    decoded = unquote(value).replace("\\", "/")
    if decoded.startswith("/"):
        decoded = decoded[1:]
    normalized = posixpath.normpath(decoded)
    if normalized in {"", ".", ".."} or normalized.startswith("../"):
        raise ValueError(f"Unsafe OOXML part name: {value!r}")
    return normalized


def relationship_part_for(owner_part: str) -> str:
    directory, filename = posixpath.split(owner_part)
    return posixpath.join(directory, "_rels", f"{filename}.rels")


def owner_part_for_relationships(rels_part: str) -> str | None:
    if rels_part == "_rels/.rels":
        return None
    directory, filename = posixpath.split(rels_part)
    if posixpath.basename(directory) != "_rels" or not filename.endswith(".rels"):
        return None
    owner_directory = posixpath.dirname(directory)
    return posixpath.join(owner_directory, filename[:-5])


def split_target(target: str) -> tuple[str, str]:
    path, marker, fragment = target.partition("#")
    return path, f"#{fragment}" if marker else ""


def resolve_relationship_target(owner_part: str | None, target: str) -> str:
    target_path, _ = split_target(target)
    decoded = unquote(target_path)
    if decoded.startswith("/"):
        return normalize_part_name(decoded)
    base = posixpath.dirname(owner_part) if owner_part else ""
    return normalize_part_name(posixpath.join(base, decoded))


def relative_relationship_target(owner_part: str, target_part: str, fragment: str = "") -> str:
    relative = posixpath.relpath(target_part, posixpath.dirname(owner_part))
    return quote(relative, safe="/-._~") + fragment


def parse_xml(entries: dict[str, bytes], part_name: str) -> ET.Element:
    try:
        payload = entries[part_name]
    except KeyError as exc:
        raise ValueError(f"Missing required OOXML part: {part_name}") from exc
    try:
        return ET.fromstring(payload)
    except ET.ParseError as exc:
        raise ValueError(f"Invalid XML in OOXML part: {part_name}") from exc


def read_package(path: Path) -> dict[str, bytes]:
    if not path.is_file():
        raise ValueError(f"PPTX file does not exist: {path}")
    try:
        with zipfile.ZipFile(path) as archive:
            bad_member = archive.testzip()
            if bad_member:
                raise ValueError(f"Corrupt ZIP member in {path}: {bad_member}")
            entries: dict[str, bytes] = {}
            for info in archive.infolist():
                if info.is_dir():
                    continue
                name = normalize_part_name(info.filename)
                if name in entries:
                    raise ValueError(f"Duplicate OOXML part in {path}: {name}")
                entries[name] = archive.read(info)
    except zipfile.BadZipFile as exc:
        raise ValueError(f"Invalid PPTX ZIP package: {path}") from exc

    for required in ("[Content_Types].xml", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"):
        if required not in entries:
            raise ValueError(f"Missing required OOXML part in {path}: {required}")
    return entries


@dataclass(frozen=True)
class ContentTypeIndex:
    defaults: dict[str, str]
    overrides: dict[str, str]

    def for_part(self, part_name: str) -> str | None:
        override = self.overrides.get(f"/{part_name}")
        if override:
            return override
        extension = posixpath.splitext(part_name)[1].lstrip(".").lower()
        return self.defaults.get(extension)


def content_type_index(entries: dict[str, bytes]) -> ContentTypeIndex:
    root = parse_xml(entries, "[Content_Types].xml")
    defaults: dict[str, str] = {}
    overrides: dict[str, str] = {}
    for child in root:
        if child.tag == qname(CONTENT_TYPES_NS, "Default"):
            defaults[str(child.attrib.get("Extension", "")).lower()] = str(
                child.attrib.get("ContentType", "")
            )
        elif child.tag == qname(CONTENT_TYPES_NS, "Override"):
            overrides[str(child.attrib.get("PartName", ""))] = str(
                child.attrib.get("ContentType", "")
            )
    return ContentTypeIndex(defaults=defaults, overrides=overrides)


class DestinationContentTypes:
    def __init__(self, entries: dict[str, bytes]) -> None:
        self.root = parse_xml(entries, "[Content_Types].xml")
        self.defaults: dict[str, ET.Element] = {}
        self.overrides: dict[str, ET.Element] = {}
        for child in self.root:
            if child.tag == qname(CONTENT_TYPES_NS, "Default"):
                self.defaults[str(child.attrib.get("Extension", "")).lower()] = child
            elif child.tag == qname(CONTENT_TYPES_NS, "Override"):
                self.overrides[str(child.attrib.get("PartName", ""))] = child

    def add_part(
        self,
        source_types: ContentTypeIndex,
        source_part: str,
        destination_part: str,
    ) -> str | None:
        content_type = source_types.for_part(source_part)
        if not content_type:
            return None

        destination_override = f"/{destination_part}"
        existing_override = self.overrides.get(destination_override)
        if existing_override is not None:
            if existing_override.attrib.get("ContentType") != content_type:
                raise ValueError(f"Conflicting content type for {destination_part}")
            return content_type

        extension = posixpath.splitext(destination_part)[1].lstrip(".").lower()
        existing_default = self.defaults.get(extension)
        if existing_default is not None and existing_default.attrib.get("ContentType") == content_type:
            return content_type

        if existing_default is None and f"/{source_part}" not in source_types.overrides:
            element = ET.SubElement(
                self.root,
                qname(CONTENT_TYPES_NS, "Default"),
                {"Extension": extension, "ContentType": content_type},
            )
            self.defaults[extension] = element
            return content_type

        element = ET.SubElement(
            self.root,
            qname(CONTENT_TYPES_NS, "Override"),
            {"PartName": destination_override, "ContentType": content_type},
        )
        self.overrides[destination_override] = element
        return content_type

    def save(self, entries: dict[str, bytes]) -> None:
        entries["[Content_Types].xml"] = serialize_xml(self.root, CONTENT_TYPES_NS)


def relationship_entries(root: ET.Element) -> list[ET.Element]:
    return [child for child in root if child.tag == qname(PACKAGE_RELS_NS, "Relationship")]


def relationship_map(entries: dict[str, bytes], rels_part: str) -> dict[str, ET.Element]:
    root = parse_xml(entries, rels_part)
    return {str(item.attrib.get("Id", "")): item for item in relationship_entries(root)}


def single_slide_part(entries: dict[str, bytes]) -> str:
    presentation = parse_xml(entries, "ppt/presentation.xml")
    slide_list = presentation.find(qname(PRESENTATION_NS, "sldIdLst"))
    slide_ids = list(slide_list) if slide_list is not None else []
    if len(slide_ids) != 1:
        raise ValueError(f"Every source file must contain exactly one slide; found {len(slide_ids)}")
    relationship_id = slide_ids[0].attrib.get(qname(DOCUMENT_RELS_NS, "id"), "")
    relation = relationship_map(entries, "ppt/_rels/presentation.xml.rels").get(relationship_id)
    if relation is None or relation.attrib.get("Type") != SLIDE_REL_TYPE:
        raise ValueError("Presentation slide relationship is missing or invalid")
    return resolve_relationship_target("ppt/presentation.xml", str(relation.attrib.get("Target", "")))


def slide_size(entries: dict[str, bytes]) -> tuple[str, str]:
    presentation = parse_xml(entries, "ppt/presentation.xml")
    size = presentation.find(qname(PRESENTATION_NS, "sldSz"))
    if size is None:
        raise ValueError("Presentation slide size is missing")
    return str(size.attrib.get("cx", "")), str(size.attrib.get("cy", ""))


def next_numbered_part(entries: dict[str, bytes], directory: str, prefix: str, suffix: str) -> str:
    expression = re.compile(
        rf"^{re.escape(directory)}/{re.escape(prefix)}(\d+){re.escape(suffix)}$"
    )
    used = [int(match.group(1)) for name in entries if (match := expression.match(name))]
    number = max(used, default=0) + 1
    while f"{directory}/{prefix}{number}{suffix}" in entries:
        number += 1
    return f"{directory}/{prefix}{number}{suffix}"


def allocate_part_name(entries: dict[str, bytes], preferred: str) -> str:
    def available(candidate: str) -> bool:
        return candidate not in entries and relationship_part_for(candidate) not in entries

    if available(preferred):
        return preferred
    directory, filename = posixpath.split(preferred)
    stem, extension = posixpath.splitext(filename)
    match = re.match(r"^(.*?)(\d+)$", stem)
    prefix = match.group(1) if match else f"{stem}_"
    number = int(match.group(2)) + 1 if match else 2
    while True:
        candidate = posixpath.join(directory, f"{prefix}{number}{extension}")
        if available(candidate):
            return candidate
        number += 1


class PresentationEditor:
    def __init__(self, entries: dict[str, bytes]) -> None:
        self.entries = entries
        self.presentation = parse_xml(entries, "ppt/presentation.xml")
        self.relationships = parse_xml(entries, "ppt/_rels/presentation.xml.rels")
        self.relationship_ids = {
            str(item.attrib.get("Id", "")) for item in relationship_entries(self.relationships)
        }
        self.master_targets: set[str] = set()
        self.notes_master_target: str | None = None
        for item in relationship_entries(self.relationships):
            relation_type = item.attrib.get("Type")
            if relation_type not in {SLIDE_MASTER_REL_TYPE, NOTES_MASTER_REL_TYPE}:
                continue
            target = resolve_relationship_target(
                "ppt/presentation.xml", str(item.attrib.get("Target", ""))
            )
            if relation_type == SLIDE_MASTER_REL_TYPE:
                self.master_targets.add(target)
            else:
                self.notes_master_target = target

    def _next_relationship_id(self) -> str:
        numeric = [
            int(match.group(1))
            for value in self.relationship_ids
            if (match := re.fullmatch(r"rId(\d+)", value))
        ]
        number = max(numeric, default=0) + 1
        while f"rId{number}" in self.relationship_ids:
            number += 1
        relationship_id = f"rId{number}"
        self.relationship_ids.add(relationship_id)
        return relationship_id

    def add_relationship(self, relation_type: str, target_part: str) -> str:
        relationship_id = self._next_relationship_id()
        ET.SubElement(
            self.relationships,
            qname(PACKAGE_RELS_NS, "Relationship"),
            {
                "Id": relationship_id,
                "Type": relation_type,
                "Target": relative_relationship_target("ppt/presentation.xml", target_part),
            },
        )
        return relationship_id

    def add_slide(self, slide_part: str) -> None:
        relationship_id = self.add_relationship(SLIDE_REL_TYPE, slide_part)
        slide_list = self.presentation.find(qname(PRESENTATION_NS, "sldIdLst"))
        if slide_list is None:
            slide_list = ET.SubElement(self.presentation, qname(PRESENTATION_NS, "sldIdLst"))
        slide_values = [int(item.attrib["id"]) for item in slide_list if item.attrib.get("id", "").isdigit()]
        slide_id = max(slide_values, default=255) + 1
        ET.SubElement(
            slide_list,
            qname(PRESENTATION_NS, "sldId"),
            {"id": str(slide_id), qname(DOCUMENT_RELS_NS, "id"): relationship_id},
        )

    def add_slide_master(self, master_part: str) -> None:
        if master_part in self.master_targets:
            return
        relationship_id = self.add_relationship(SLIDE_MASTER_REL_TYPE, master_part)
        master_list = self.presentation.find(qname(PRESENTATION_NS, "sldMasterIdLst"))
        if master_list is None:
            master_list = ET.Element(qname(PRESENTATION_NS, "sldMasterIdLst"))
            slide_list = self.presentation.find(qname(PRESENTATION_NS, "sldIdLst"))
            insertion_index = list(self.presentation).index(slide_list) if slide_list is not None else 0
            self.presentation.insert(insertion_index, master_list)
        master_values = [
            int(item.attrib["id"])
            for item in master_list
            if item.attrib.get("id", "").isdigit()
        ]
        master_id = max(master_values, default=2_147_483_647) + 1
        if master_id > 4_294_967_295:
            raise ValueError("Presentation has exhausted the slide master ID range")
        ET.SubElement(
            master_list,
            qname(PRESENTATION_NS, "sldMasterId"),
            {"id": str(master_id), qname(DOCUMENT_RELS_NS, "id"): relationship_id},
        )
        self.master_targets.add(master_part)

    def save(self) -> None:
        self.entries["ppt/presentation.xml"] = serialize_xml(self.presentation)
        self.entries["ppt/_rels/presentation.xml.rels"] = serialize_xml(
            self.relationships, PACKAGE_RELS_NS
        )


class PartImporter:
    def __init__(
        self,
        source: dict[str, bytes],
        destination: dict[str, bytes],
        destination_types: DestinationContentTypes,
        notes_master_target: str | None,
    ) -> None:
        self.source = source
        self.destination = destination
        self.source_types = content_type_index(source)
        self.destination_types = destination_types
        self.notes_master_target = notes_master_target
        self.mapping: dict[str, str] = {}
        self.imported_types: dict[str, str] = {}
        self.imported_parts: set[str] = set()

    def import_part(self, source_part: str, preferred_destination: str | None = None) -> str:
        existing = self.mapping.get(source_part)
        if existing:
            return existing
        if source_part not in self.source:
            raise ValueError(f"Relationship target is missing from source PPTX: {source_part}")

        destination_part = preferred_destination or allocate_part_name(
            self.destination, source_part
        )
        if destination_part in self.destination:
            raise ValueError(f"OOXML destination part already exists: {destination_part}")
        self.mapping[source_part] = destination_part
        self.destination[destination_part] = self.source[source_part]
        self.imported_parts.add(destination_part)
        content_type = self.destination_types.add_part(
            self.source_types, source_part, destination_part
        )
        if content_type:
            self.imported_types[destination_part] = content_type

        source_rels_part = relationship_part_for(source_part)
        if source_rels_part not in self.source:
            return destination_part

        relationships = parse_xml(self.source, source_rels_part)
        for relation in relationship_entries(relationships):
            if str(relation.attrib.get("TargetMode", "")).lower() == "external":
                continue
            original_target = str(relation.attrib.get("Target", ""))
            _, fragment = split_target(original_target)
            source_target = resolve_relationship_target(source_part, original_target)
            relation_type = str(relation.attrib.get("Type", ""))
            if relation_type == NOTES_MASTER_REL_TYPE and self.notes_master_target:
                destination_target = self.notes_master_target
                self.mapping[source_target] = destination_target
            else:
                destination_target = self.import_part(source_target)
            relation.attrib["Target"] = relative_relationship_target(
                destination_part, destination_target, fragment
            )

        destination_rels_part = relationship_part_for(destination_part)
        if destination_rels_part in self.destination:
            raise ValueError(f"OOXML relationship part already exists: {destination_rels_part}")
        self.destination[destination_rels_part] = serialize_xml(
            relationships, PACKAGE_RELS_NS
        )
        return destination_part

    def validate_mapping(self) -> None:
        for source_part, destination_part in self.mapping.items():
            if destination_part not in self.imported_parts:
                continue
            if self.source[source_part] != self.destination[destination_part]:
                raise ValueError(f"Imported OOXML part changed unexpectedly: {source_part}")

            source_rels_part = relationship_part_for(source_part)
            destination_rels_part = relationship_part_for(destination_part)
            if source_rels_part not in self.source:
                if destination_rels_part in self.destination:
                    raise ValueError(f"Unexpected relationship part: {destination_rels_part}")
                continue
            if destination_rels_part not in self.destination:
                raise ValueError(f"Missing imported relationship part: {destination_rels_part}")

            source_relations = relationship_map(self.source, source_rels_part)
            destination_relations = relationship_map(self.destination, destination_rels_part)
            if source_relations.keys() != destination_relations.keys():
                raise ValueError(f"Relationship IDs changed while importing {source_part}")
            for relationship_id, source_relation in source_relations.items():
                destination_relation = destination_relations[relationship_id]
                for attribute in ("Type", "TargetMode"):
                    if source_relation.attrib.get(attribute) != destination_relation.attrib.get(attribute):
                        raise ValueError(
                            f"Relationship {relationship_id} metadata changed while importing {source_part}"
                        )
                if str(source_relation.attrib.get("TargetMode", "")).lower() == "external":
                    if source_relation.attrib.get("Target") != destination_relation.attrib.get("Target"):
                        raise ValueError(
                            f"External relationship {relationship_id} changed while importing {source_part}"
                        )
                    continue
                source_target = resolve_relationship_target(
                    source_part, str(source_relation.attrib.get("Target", ""))
                )
                expected_target = self.mapping.get(source_target)
                actual_target = resolve_relationship_target(
                    destination_part, str(destination_relation.attrib.get("Target", ""))
                )
                if not expected_target or actual_target != expected_target:
                    raise ValueError(
                        f"Relationship {relationship_id} target changed while importing {source_part}"
                    )


def update_app_slide_count(entries: dict[str, bytes], count: int) -> None:
    part_name = "docProps/app.xml"
    if part_name not in entries:
        return
    try:
        root = parse_xml(entries, part_name)
    except ValueError:
        return
    slides = root.find(qname(EXTENDED_PROPS_NS, "Slides"))
    if slides is not None:
        slides.text = str(count)
    entries[part_name] = serialize_xml(root, EXTENDED_PROPS_NS)


def validate_internal_relationships(entries: dict[str, bytes]) -> None:
    missing: list[str] = []
    for rels_part in sorted(name for name in entries if name.endswith(".rels")):
        owner_part = owner_part_for_relationships(rels_part)
        try:
            relationships = parse_xml(entries, rels_part)
        except ValueError as exc:
            missing.append(str(exc))
            continue
        for relation in relationship_entries(relationships):
            if str(relation.attrib.get("TargetMode", "")).lower() == "external":
                continue
            try:
                target = resolve_relationship_target(
                    owner_part, str(relation.attrib.get("Target", ""))
                )
            except ValueError as exc:
                missing.append(f"{rels_part}: {exc}")
                continue
            if target not in entries:
                missing.append(f"{rels_part} -> {target}")
    if missing:
        raise ValueError("Broken internal OOXML relationships:\n" + "\n".join(missing[:30]))


def write_package(entries: dict[str, bytes], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{uuid.uuid4().hex}.tmp")
    ordered_names = [name for name in ("[Content_Types].xml", "_rels/.rels") if name in entries]
    ordered_names.extend(name for name in entries if name not in set(ordered_names))
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in ordered_names:
                archive.writestr(name, entries[name])
        with zipfile.ZipFile(temporary) as archive:
            bad_member = archive.testzip()
            if bad_member:
                raise ValueError(f"Merged PPTX contains a corrupt ZIP member: {bad_member}")
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def merge_presentations(pages: list[Path], output: Path) -> dict:
    if len(pages) < 2:
        raise ValueError("At least two approved single-page PPTX files are required")
    source_packages = [read_package(page) for page in pages]
    for package in source_packages:
        single_slide_part(package)
    expected_size = slide_size(source_packages[0])
    for index, package in enumerate(source_packages[1:], start=2):
        if slide_size(package) != expected_size:
            raise ValueError(f"Slide {index} uses a different page size")

    destination = dict(source_packages[0])
    destination_types = DestinationContentTypes(destination)
    presentation = PresentationEditor(destination)
    imported_part_count = 0

    for package in source_packages[1:]:
        source_slide = single_slide_part(package)
        destination_slide = next_numbered_part(
            destination, "ppt/slides", "slide", ".xml"
        )
        importer = PartImporter(
            source=package,
            destination=destination,
            destination_types=destination_types,
            notes_master_target=presentation.notes_master_target,
        )
        importer.import_part(source_slide, destination_slide)
        importer.validate_mapping()
        presentation.add_slide(destination_slide)
        for part_name, content_type in importer.imported_types.items():
            if content_type == SLIDE_MASTER_CONTENT_TYPE:
                presentation.add_slide_master(part_name)
        imported_part_count += len(importer.imported_parts)

    presentation.save()
    destination_types.save(destination)
    update_app_slide_count(destination, len(pages))
    validate_internal_relationships(destination)
    write_package(destination, output)

    merged_entries = read_package(output)
    merged_presentation = parse_xml(merged_entries, "ppt/presentation.xml")
    slide_list = merged_presentation.find(qname(PRESENTATION_NS, "sldIdLst"))
    merged_slide_count = len(list(slide_list)) if slide_list is not None else 0
    if merged_slide_count != len(pages):
        raise ValueError(
            f"Merged deck contains {merged_slide_count} slides; expected {len(pages)}"
        )
    return {
        "slideCount": merged_slide_count,
        "importedPartCount": imported_part_count,
        "relationshipValidation": True,
    }


def run_command(command: list[str], timeout: int = 180) -> None:
    completed = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()[-2_000:]
        raise RuntimeError(f"Command failed ({completed.returncode}): {detail}")


def render_pdf_to_png(pdf: Path, output_prefix: Path, dpi: int) -> list[Path]:
    run_command(
        ["pdftoppm", "-png", "-r", str(dpi), str(pdf), str(output_prefix)],
        timeout=180,
    )
    return sorted(
        output_prefix.parent.glob(f"{output_prefix.name}-*.png"),
        key=lambda path: int(re.search(r"-(\d+)\.png$", path.name).group(1)),
    )


def verify_render_regression(
    pages: list[Path],
    merged: Path,
    qa_dir: Path,
    pdf_output: Path | None,
    threshold: float,
    changed_pixel_threshold: float,
    dpi: int,
) -> dict:
    try:
        import numpy as np
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError("Pillow and numpy are required for merge regression QA") from exc

    if not shutil.which("libreoffice") or not shutil.which("pdftoppm"):
        raise RuntimeError("LibreOffice and pdftoppm are required for merge regression QA")

    qa_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pptx-merge-qa-", dir=str(qa_dir)) as raw_temp:
        temporary = Path(raw_temp)
        inputs = temporary / "inputs"
        pdfs = temporary / "pdfs"
        renders = temporary / "renders"
        inputs.mkdir()
        pdfs.mkdir()
        renders.mkdir()

        copied_pages: list[Path] = []
        for index, page in enumerate(pages, start=1):
            target = inputs / f"page-{index:03d}.pptx"
            shutil.copy2(page, target)
            copied_pages.append(target)
        merged_copy = inputs / "merged.pptx"
        shutil.copy2(merged, merged_copy)

        profile_dir = temporary / "libreoffice-profile"
        command = [
            "libreoffice",
            f"-env:UserInstallation={profile_dir.resolve().as_uri()}",
            "--headless",
            "--convert-to",
            "pdf",
            "--outdir",
            str(pdfs),
            *(str(path) for path in copied_pages),
            str(merged_copy),
        ]
        run_command(command, timeout=240)

        approved_images: list[Path] = []
        for index in range(1, len(pages) + 1):
            pdf = pdfs / f"page-{index:03d}.pdf"
            if not pdf.is_file():
                raise RuntimeError(f"LibreOffice did not render source page {index}")
            images = render_pdf_to_png(pdf, renders / f"approved-{index:03d}", dpi)
            if len(images) != 1:
                raise RuntimeError(f"Source page {index} rendered as {len(images)} pages")
            approved_images.append(images[0])

        merged_pdf = pdfs / "merged.pdf"
        if not merged_pdf.is_file():
            raise RuntimeError("LibreOffice did not render the merged deck")
        merged_images = render_pdf_to_png(merged_pdf, renders / "merged", dpi)
        if len(merged_images) != len(pages):
            raise RuntimeError(
                f"Merged deck rendered as {len(merged_images)} pages; expected {len(pages)}"
            )

        results: list[dict] = []
        passed = True
        approved_output = qa_dir / "approved"
        merged_output = qa_dir / "merged"
        shutil.rmtree(approved_output, ignore_errors=True)
        shutil.rmtree(merged_output, ignore_errors=True)
        approved_output.mkdir()
        merged_output.mkdir()
        for index, (approved_path, merged_path) in enumerate(
            zip(approved_images, merged_images, strict=True), start=1
        ):
            approved_image = Image.open(approved_path).convert("RGB")
            merged_image = Image.open(merged_path).convert("RGB")
            dimensions_match = approved_image.size == merged_image.size
            if dimensions_match:
                approved_array = np.asarray(approved_image, dtype=np.int16)
                merged_array = np.asarray(merged_image, dtype=np.int16)
                absolute = np.abs(approved_array - merged_array)
                mean_absolute_difference = float(absolute.mean())
                changed_pixel_ratio = float((absolute.max(axis=2) > 2).mean())
            else:
                mean_absolute_difference = float("inf")
                changed_pixel_ratio = 1.0
            page_passed = (
                dimensions_match
                and mean_absolute_difference <= threshold
                and changed_pixel_ratio <= changed_pixel_threshold
            )
            passed = passed and page_passed

            approved_target = approved_output / f"page-{index:03d}.png"
            merged_target = merged_output / f"page-{index:03d}.png"
            shutil.copy2(approved_path, approved_target)
            shutil.copy2(merged_path, merged_target)
            results.append(
                {
                    "page": index,
                    "passed": page_passed,
                    "dimensionsMatch": dimensions_match,
                    "meanAbsoluteDifference": round(mean_absolute_difference, 6),
                    "changedPixelRatio": round(changed_pixel_ratio, 8),
                    "approvedRender": str(approved_target),
                    "mergedRender": str(merged_target),
                }
            )

        if passed and pdf_output is not None:
            pdf_output.parent.mkdir(parents=True, exist_ok=True)
            temporary_pdf = pdf_output.with_name(
                f".{pdf_output.name}.{uuid.uuid4().hex}.tmp"
            )
            try:
                shutil.copy2(merged_pdf, temporary_pdf)
                os.replace(temporary_pdf, pdf_output)
            finally:
                temporary_pdf.unlink(missing_ok=True)

    report = {
        "engine": "libreoffice-pdftoppm",
        "dpi": dpi,
        "threshold": threshold,
        "changedPixelThreshold": changed_pixel_threshold,
        "passed": passed,
        "pages": results,
    }
    report_path = qa_dir / "regression.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report["report"] = str(report_path)
    return report


def write_manifest(path: Path, manifest: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Merge approved single-page PPTX files on Linux without regenerating slides."
    )
    parser.add_argument("--pages", nargs="+", required=True, help="Approved single-page PPTX files")
    parser.add_argument("--out", required=True, help="Merged PPTX path")
    parser.add_argument("--manifest-out", required=True, help="Merge manifest JSON")
    parser.add_argument("--pdf-out", help="Final PDF path; defaults beside the merged PPTX")
    parser.add_argument("--qa-dir", help="Regression QA directory; defaults beside the manifest")
    parser.add_argument("--threshold", type=float, default=0.25, help="Maximum mean RGB difference")
    parser.add_argument(
        "--changed-pixel-threshold",
        type=float,
        default=0.01,
        help="Maximum ratio of pixels whose RGB difference exceeds 2",
    )
    parser.add_argument("--dpi", type=int, default=120, help="Regression render DPI")
    parser.add_argument("--skip-render-verification", action="store_true")
    args = parser.parse_args()

    pages = [Path(value).resolve() for value in args.pages]
    output = Path(args.out).resolve()
    manifest_path = Path(args.manifest_out).resolve()
    qa_dir = (
        Path(args.qa_dir).resolve()
        if args.qa_dir
        else manifest_path.parent / f"{output.stem}-merge-regression"
    )
    pdf_output = Path(args.pdf_out).resolve() if args.pdf_out else output.with_suffix(".pdf")
    manifest = {
        "method": "merge_approved_single_page_pptx",
        "engine": "ea_linux_ooxml_v1",
        "merged": False,
        "output": str(output),
        "source_single_page_pptx": [str(path) for path in pages],
        "regenerated_pages": False,
        "merge_regression_rendered": False,
        "merge_regression_pass": False,
    }

    try:
        structure = merge_presentations(pages, output)
        manifest.update(structure)
        manifest["merged"] = True
        if not args.skip_render_verification:
            pdf_output.unlink(missing_ok=True)
            regression = verify_render_regression(
                pages=pages,
                merged=output,
                qa_dir=qa_dir,
                pdf_output=pdf_output,
                threshold=args.threshold,
                changed_pixel_threshold=args.changed_pixel_threshold,
                dpi=args.dpi,
            )
            manifest["merge_regression_rendered"] = True
            manifest["merge_regression_pass"] = bool(regression["passed"])
            manifest["merge_regression"] = regression
            if regression["passed"] and pdf_output.is_file():
                manifest["pdfOutput"] = str(pdf_output)
        write_manifest(manifest_path, manifest)
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 0 if manifest["merge_regression_pass"] or args.skip_render_verification else 2
    except Exception as exc:
        manifest["failure"] = str(exc)
        write_manifest(manifest_path, manifest)
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
