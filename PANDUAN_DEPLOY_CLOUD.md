# Panduan Deploy Web AFK Server ke Cloud (24 Jam Non-Stop Tanpa Laptop)

Dengan mengikuti panduan ini, aplikasi Web AFK Server Anda akan berjalan di Cloud Server secara **GRATIS 24/7**, sehingga Anda bisa **mematikan laptop total** dan mengontrol bot dari HP / Web Browser kapan saja!

---

## Opsi 1: Deploy di Render.com (Gratis & Paling Mudah)

1. **Upload Kode ke GitHub**:
   - Buat akun di [GitHub.com](https://github.com).
   - Buat Repository baru (misal dinamai `minecraft-afk-web`).
   - Upload seluruh isi folder `d:\minecraftr\afk app` ke repository GitHub Anda.

2. **Daftar & Hubungkan ke Render**:
   - Buka [Render.com](https://render.com) dan Sign Up menggunakan akun GitHub Anda.
   - Di dashboard Render, klik tombol **New +** -> pilih **Web Service**.

3. **Pilih Repository GitHub**:
   - Sambungkan repository `minecraft-afk-web` yang baru Anda buat.

4. **Konfigurasi Web Service**:
   - **Name**: `minecraft-afk-bot` (atau nama lain pilihan Anda)
   - **Region**: Singapore (atau terdekat)
   - **Language**: Docker (atau Node)
   - **Instance Type**: **Free**
   - Klik tombol **Create Web Service**.

5. **Selesai!**:
   - Tunggu proses build selesai (sekitar 2-3 menit).
   - Render akan memberikan URL publik seperti: `https://minecraft-afk-bot.onrender.com`.
   - Buka URL tersebut di HP atau Laptop Anda. Klik **Mulai Bot**. Sekarang Anda bisa **mematikan laptop Anda**!

---

## Opsi 2: Deploy di Railway.app

1. Buka [Railway.app](https://railway.app) dan login dengan GitHub.
2. Klik **New Project** -> **Deploy from GitHub repo**.
3. Pilih repository bot Anda.
4. Railway akan otomatis mendeteksi Dockerfile dan menjalankan web server.
5. Pada tab **Settings** -> **Networking**, klik **Generate Domain** untuk mendapatkan link web Anda.

---

## Cara Menggunakan Web Dashboard

1. **Mulai / Hentikan Bot**: Tekan tombol **Mulai Bot** di pojok kanan atas.
2. **Kirim Pesan / Command**: Ketik perintah seperti `/spawn` atau `/pay` di bar bagian bawah terminal live console.
3. **Ubah Pengaturan**: Masuk ke menu **Pengaturan Bot** untuk mengubah Host Server (misal `alwination.id`), Port, Username, atau Fitur Anti-AFK.

## Mengontrol dari PowerShell (tanpa membuka dashboard)

Server aplikasi tetap harus berjalan, tetapi dashboard web tidak perlu dibuka. Di PowerShell, masuk ke folder proyek lalu jalankan:

```powershell
npm start
```

Buka jendela PowerShell kedua di folder yang sama dan jalankan:

```powershell
.\afk.ps1
```

Untuk server pada alamat lain, berikan URL server:

```powershell
.\afk.ps1 -ServerUrl https://your-server.example.com
```

CLI meminta kata sandi dashboard bila proteksi aktif. Gunakan HTTPS untuk koneksi ke server jarak jauh. Sesi dapat dikunci dan CLI ditutup dengan `logout` atau `exit`; token sesi tidak disimpan ke file. Ketik `help` di prompt `afk>` untuk daftar perintah. Fitur yang tersedia meliputi status, log, akun, mulai/hentikan bot, chat dan command, pengaturan koneksi dan auto-command, quick command, keamanan, inventory, scoreboard, entity, serta melihat dan mengklik slot GUI Minecraft.

Radar/POV 3D dan tampilan grafis chest tidak dirender di terminal; informasi bot dan slot yang dapat digunakan ditampilkan sebagai teks. Server juga harus dapat dijangkau melalui HTTP dari komputer yang menjalankan PowerShell.
