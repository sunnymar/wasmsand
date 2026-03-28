use lopdf::{Document, Object, ObjectId};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::Path;

pub const EXIT_OK: i32 = 0;
pub const EXIT_INPUT: i32 = 1;
pub const EXIT_OUTPUT: i32 = 2;
pub const EXIT_PERMISSION: i32 = 3;
pub const EXIT_OTHER: i32 = 99;

/// Poppler tools print version info to stderr (matching poppler convention).
pub fn print_version(command: &str) {
    eprintln!("{command} 0.1.0");
}

/// Poppler tools print help to stderr (matching poppler convention).
pub fn print_help(usage: &str, options: &[&str]) {
    eprintln!("Usage: {usage}");
    if !options.is_empty() {
        eprintln!();
        eprintln!("Options:");
        for option in options {
            eprintln!("  {option}");
        }
    }
}

pub fn load_document(path: &str) -> Result<Document, String> {
    Document::load(path).map_err(|err| format!("failed to open '{path}': {err}"))
}

pub fn save_document(doc: &mut Document, path: &str) -> Result<(), String> {
    doc.save(path)
        .map(|_| ())
        .map_err(|err| format!("failed to write '{path}': {err}"))
}

pub fn object_to_string(doc: &Document, obj: &Object) -> Option<String> {
    match obj {
        Object::String(bytes, _) => Some(String::from_utf8_lossy(bytes).into_owned()),
        Object::Name(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        Object::Reference(id) => doc
            .get_object(*id)
            .ok()
            .and_then(|resolved| object_to_string(doc, resolved)),
        _ => None,
    }
}

pub fn object_to_i64(doc: &Document, obj: &Object) -> Option<i64> {
    match obj {
        Object::Integer(value) => Some(*value),
        Object::Real(value) => Some(*value as i64),
        Object::Reference(id) => doc
            .get_object(*id)
            .ok()
            .and_then(|resolved| object_to_i64(doc, resolved)),
        _ => None,
    }
}

pub fn pages_in_range(
    pages: &BTreeMap<u32, ObjectId>,
    first: Option<u32>,
    last: Option<u32>,
) -> Vec<(u32, ObjectId)> {
    let start = first.unwrap_or(1);
    let end = last.unwrap_or_else(|| pages.keys().next_back().copied().unwrap_or(0));
    pages
        .iter()
        .filter_map(|(page_no, object_id)| {
            if *page_no >= start && *page_no <= end {
                Some((*page_no, *object_id))
            } else {
                None
            }
        })
        .collect()
}

pub fn media_box(doc: &Document, page_id: ObjectId) -> Option<(f32, f32, f32, f32)> {
    let page = doc.get_object(page_id).ok()?.as_dict().ok()?;
    let media_box = page.get(b"MediaBox").ok()?;
    let array = match media_box {
        Object::Array(items) => items,
        Object::Reference(id) => doc.get_object(*id).ok()?.as_array().ok()?,
        _ => return None,
    };
    if array.len() != 4 {
        return None;
    }
    let mut nums = [0f32; 4];
    for (idx, item) in array.iter().enumerate() {
        nums[idx] = match item {
            Object::Integer(value) => *value as f32,
            Object::Real(value) => *value,
            Object::Reference(id) => {
                let resolved = doc.get_object(*id).ok()?;
                match resolved {
                    Object::Integer(value) => *value as f32,
                    Object::Real(value) => *value,
                    _ => return None,
                }
            }
            _ => return None,
        };
    }
    Some((nums[0], nums[1], nums[2], nums[3]))
}

pub fn page_size_string(doc: &Document, page_id: ObjectId) -> Option<String> {
    let (x1, y1, x2, y2) = media_box(doc, page_id)?;
    let width = (x2 - x1).abs();
    let height = (y2 - y1).abs();
    Some(format!("{width:.2} x {height:.2} pts"))
}

pub fn file_size(path: &str) -> Option<u64> {
    std::fs::metadata(path).ok().map(|meta| meta.len())
}

pub fn path_basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

pub fn metadata_text(doc: &Document) -> Option<String> {
    let info_ref = doc.trailer.get(b"Info").ok()?;
    let info_obj = match info_ref {
        Object::Reference(id) => doc.get_object(*id).ok()?,
        other => other,
    };
    Some(format!("{info_obj:#?}"))
}

pub fn catalog_metadata_stream(doc: &Document) -> Option<String> {
    let root = doc.trailer.get(b"Root").ok()?;
    let catalog = match root {
        Object::Reference(id) => doc.get_object(*id).ok()?.as_dict().ok()?,
        _ => return None,
    };
    let metadata = catalog.get(b"Metadata").ok()?;
    let stream = match metadata {
        Object::Reference(id) => doc.get_object(*id).ok()?.as_stream().ok()?,
        _ => return None,
    };
    String::from_utf8(stream.content.clone()).ok()
}

pub fn info_output(
    doc: &Document,
    input_path: &str,
    first: Option<u32>,
    last: Option<u32>,
    show_boxes: bool,
    show_meta: bool,
) -> String {
    if show_meta {
        if let Some(stream) = catalog_metadata_stream(doc) {
            return stream;
        }
        if let Some(info) = metadata_text(doc) {
            return info;
        }
        return String::new();
    }

    let mut out = String::new();
    let pages = doc.get_pages();
    let info_dict = doc.trailer.get(b"Info").ok().and_then(|obj| match obj {
        Object::Reference(id) => doc.get_object(*id).ok()?.as_dict().ok(),
        _ => None,
    });

    if let Some(info) = info_dict {
        for (label, key) in [
            ("Title", b"Title".as_slice()),
            ("Subject", b"Subject".as_slice()),
            ("Keywords", b"Keywords".as_slice()),
            ("Author", b"Author".as_slice()),
            ("Creator", b"Creator".as_slice()),
            ("Producer", b"Producer".as_slice()),
            ("CreationDate", b"CreationDate".as_slice()),
            ("ModDate", b"ModDate".as_slice()),
        ] {
            if let Ok(obj) = info.get(key) {
                if let Some(value) = object_to_string(doc, obj) {
                    let _ = writeln!(out, "{label}: {value}");
                }
            }
        }
    }

    let _ = writeln!(out, "Pages: {}", pages.len());
    let _ = writeln!(
        out,
        "Encrypted: {}",
        if doc.is_encrypted() { "yes" } else { "no" }
    );
    if let Some(size) = file_size(input_path) {
        let _ = writeln!(out, "File size: {} bytes", size);
    }
    let _ = writeln!(out, "File name: {}", path_basename(input_path));
    let _ = writeln!(out, "PDF version: {}", doc.version);

    let selected_pages = pages_in_range(&pages, first, last);
    if selected_pages.len() == 1 {
        if let Some((_, page_id)) = selected_pages.first() {
            if let Some(size) = page_size_string(doc, *page_id) {
                let _ = writeln!(out, "Page size: {size}");
            }
        }
    } else if !selected_pages.is_empty() {
        for (page_no, page_id) in &selected_pages {
            if let Some(size) = page_size_string(doc, *page_id) {
                let _ = writeln!(out, "Page {page_no} size: {size}");
            }
        }
    }

    if show_boxes {
        for (page_no, page_id) in selected_pages {
            if let Some((x1, y1, x2, y2)) = media_box(doc, page_id) {
                let _ = writeln!(
                    out,
                    "Page {page_no} MediaBox: [{x1:.2} {y1:.2} {x2:.2} {y2:.2}]"
                );
            }
        }
    }

    out
}

pub fn extract_page_to_document(source: &Document, target_page: u32) -> Result<Document, String> {
    let mut doc = source.clone();
    let page_numbers: Vec<u32> = doc
        .get_pages()
        .keys()
        .copied()
        .filter(|page_no| *page_no != target_page)
        .collect();
    doc.delete_pages(&page_numbers);
    doc.prune_objects();
    doc.renumber_objects();
    Ok(doc)
}

pub fn merge_documents(docs: Vec<Document>) -> Result<Document, String> {
    use lopdf::{Bookmark, Object};

    let mut max_id = 1;
    let mut page_num = 1;
    let mut documents_pages = BTreeMap::new();
    let mut documents_objects = BTreeMap::new();
    let mut document = Document::with_version("1.5");
    let mut layer_parent: [Option<u32>; 4] = [None; 4];
    let mut last_layer = 0;

    layer_parent[0] = Some(document.add_bookmark(
        Bookmark::new("Table of Contents".to_string(), [0.0, 0.0, 0.0], 0, (0, 0)),
        None,
    ));

    for mut doc in docs {
        let layer = 1u32;
        let color = [0.0, 0.0, 0.0];
        let format = 0;
        let mut display = String::new();
        let mut first_object = None;

        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;

        let pages = doc.get_pages();
        for object_id in pages.into_values() {
            if first_object.is_none() {
                first_object = Some(object_id);
                display = format!("Page {page_num}");
            }
            let object = doc
                .get_object(object_id)
                .map_err(|err| format!("failed to read page object: {err}"))?
                .to_owned();
            documents_pages.insert(object_id, object);
            page_num += 1;
        }

        documents_objects.extend(doc.objects);

        let object = first_object.unwrap_or((0, 0));
        if layer == 1 {
            layer_parent[1] = Some(document.add_bookmark(
                Bookmark::new(display, color, format, object),
                layer_parent[0],
            ));
            last_layer = 1;
        } else if last_layer >= layer || last_layer == layer - 1 {
            layer_parent[layer as usize] = Some(document.add_bookmark(
                Bookmark::new(display, color, format, object),
                layer_parent[(layer - 1) as usize],
            ));
            last_layer = layer;
        }
    }

    let mut catalog_object: Option<(ObjectId, Object)> = None;
    let mut pages_object: Option<(ObjectId, Object)> = None;

    for (object_id, object) in documents_objects {
        match object.type_name().unwrap_or(b"") {
            b"Catalog" => {
                catalog_object = Some((
                    catalog_object.map(|(id, _)| id).unwrap_or(object_id),
                    object,
                ));
            }
            b"Pages" => {
                if let Ok(dictionary) = object.as_dict() {
                    let mut dictionary = dictionary.clone();
                    if let Some((_, ref existing)) = pages_object {
                        if let Ok(old_dictionary) = existing.as_dict() {
                            dictionary.extend(old_dictionary);
                        }
                    }
                    pages_object = Some((
                        pages_object.map(|(id, _)| id).unwrap_or(object_id),
                        Object::Dictionary(dictionary),
                    ));
                }
            }
            b"Page" | b"Outlines" | b"Outline" => {}
            _ => {
                document.objects.insert(object_id, object);
            }
        }
    }

    let Some((catalog_id, catalog_object)) = catalog_object else {
        return Err("Catalog root not found.".to_string());
    };
    let Some((page_id, page_object)) = pages_object else {
        return Err("Pages root not found.".to_string());
    };

    for (object_id, object) in &documents_pages {
        if let Ok(dictionary) = object.as_dict() {
            let mut dictionary = dictionary.clone();
            dictionary.set("Parent", page_id);
            document
                .objects
                .insert(*object_id, Object::Dictionary(dictionary));
        }
    }

    if let Ok(dictionary) = page_object.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Count", documents_pages.len() as u32);
        dictionary.set(
            "Kids",
            documents_pages
                .keys()
                .copied()
                .map(Object::Reference)
                .collect::<Vec<_>>(),
        );
        document
            .objects
            .insert(page_id, Object::Dictionary(dictionary));
    }

    if let Ok(dictionary) = catalog_object.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Pages", page_id);
        dictionary.remove(b"Outlines");
        document
            .objects
            .insert(catalog_id, Object::Dictionary(dictionary));
    }

    document.trailer.set("Root", catalog_id);
    document.max_id = document.objects.len() as u32;
    document.renumber_objects();
    document.adjust_zero_pages();

    if let Some(outline_id) = document.build_outline() {
        if let Ok(Object::Reference(new_catalog_id)) = document.trailer.get(b"Root").cloned() {
            if let Ok(Object::Dictionary(dict)) = document.get_object_mut(new_catalog_id) {
                dict.set("Outlines", Object::Reference(outline_id));
            }
        }
    }

    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_test_pdf(page_count: usize) -> Document {
        let mut pdf = "%PDF-1.4\n".to_string();
        let mut objects: Vec<(usize, String)> = Vec::new();
        let mut page_ids = Vec::new();

        objects.push((1, "<< /Type /Catalog /Pages 2 0 R >>".to_string()));

        let mut next_id = 3;
        for _ in 0..page_count {
            page_ids.push(next_id);
            next_id += 1;
        }

        let kids = page_ids
            .iter()
            .map(|id| format!("{id} 0 R"))
            .collect::<Vec<_>>()
            .join(" ");
        objects.push((
            2,
            format!("<< /Type /Pages /Kids [{kids}] /Count {page_count} >>"),
        ));

        for page_id in page_ids {
            objects.push((
                page_id,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".to_string(),
            ));
        }

        let mut offsets = BTreeMap::new();
        for (id, body) in &objects {
            offsets.insert(*id, pdf.len());
            pdf.push_str(&format!("{id} 0 obj\n{body}\nendobj\n"));
        }

        let xref_offset = pdf.len();
        pdf.push_str(&format!("xref\n0 {next_id}\n"));
        pdf.push_str("0000000000 65535 f \n");
        for id in 1..next_id {
            let offset = offsets.get(&id).copied().unwrap_or(0);
            pdf.push_str(&format!("{offset:010} 00000 n \n"));
        }
        pdf.push_str("trailer\n");
        pdf.push_str(&format!("<< /Size {next_id} /Root 1 0 R >>\n"));
        pdf.push_str(&format!("startxref\n{xref_offset}\n%%EOF\n"));

        Document::load_mem(pdf.as_bytes()).expect("test PDF should load")
    }

    #[test]
    fn merge_documents_sets_outlines_on_the_renumbered_catalog() {
        let merged = merge_documents(vec![build_test_pdf(1), build_test_pdf(1)])
            .expect("merge should succeed");

        let root_id = match merged.trailer.get(b"Root").expect("root in trailer") {
            Object::Reference(id) => *id,
            other => panic!("unexpected root object: {other:?}"),
        };
        let catalog = merged
            .get_object(root_id)
            .expect("catalog object")
            .as_dict()
            .expect("catalog dict");

        assert!(
            catalog.get(b"Outlines").is_ok(),
            "merged PDF should retain outlines"
        );
    }

    #[test]
    fn merge_documents_labels_bookmarks_using_cumulative_page_numbers() {
        let merged = merge_documents(vec![build_test_pdf(3), build_test_pdf(2)])
            .expect("merge should succeed");

        assert_eq!(
            merged.bookmarks.len(),
            1,
            "table of contents bookmark should be the root"
        );

        let toc_id = merged.bookmarks[0];
        let toc = merged.bookmark_table.get(&toc_id).expect("toc bookmark");
        assert_eq!(
            toc.children.len(),
            2,
            "expected one bookmark per input document"
        );

        let first_doc = merged
            .bookmark_table
            .get(&toc.children[0])
            .expect("first document bookmark");
        let second_doc = merged
            .bookmark_table
            .get(&toc.children[1])
            .expect("second document bookmark");

        assert_eq!(first_doc.title, "Page 1");
        assert_eq!(second_doc.title, "Page 4");
    }
}
