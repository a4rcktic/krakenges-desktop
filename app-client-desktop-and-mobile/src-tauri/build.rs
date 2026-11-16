fn main() {
    tauri_build::build();

    // El template del inyector (src/injector_template.js) se cifra al compilar
    // (stream XOR + LCG, mismo esquema que el transporte runtime por seed) y se
    // incluye en el crate como blob opaco. El binario ya no lleva las técnicas
    // en texto plano: strings/grep estáticos no encuentran el código de huellas.
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let tmpl_path = manifest.join("src").join("injector_template.js");
    let tmpl = std::fs::read_to_string(&tmpl_path).expect("src/injector_template.js no encontrado");
    let out_dir_str = std::env::var("OUT_DIR").expect("OUT_DIR");
    let out_dir = std::path::Path::new(&out_dir_str);

    const KEY_SEED: u32 = 0x6D_A5_6B_31;
    let mut key = KEY_SEED ^ 0x9E37_79B9;
    let enc: Vec<u8> = tmpl
        .bytes()
        .map(|b| {
            let m = b ^ (key as u8);
            key = key.wrapping_mul(1664525).wrapping_add(1013904223);
            m
        })
        .collect();

    let mut src = format!("pub static IDENT_KEY_SEED: u32 = {};\n", KEY_SEED);
    src.push_str(&format!(
        "pub static IDENT_ENC: &[u8] = &[{}];\n",
        enc.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(",")
    ));
    std::fs::write(out_dir.join("ident_enc.rs"), src).expect("escribir ident_enc.rs");

    println!("cargo:rerun-if-changed={}", tmpl_path.display());
}