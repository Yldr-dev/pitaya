<p align="center"><img src="assets/icon.png" width="96" alt="Pitaya"></p>

# Pitaya

Arka planda çalışan, tek kısayolla video indiren küçük bir Windows uygulaması.

1. Bir video linkini kopyala (YouTube, X, Instagram, TikTok, Reddit… yt-dlp'nin desteklediği 1000+ site).
2. Kısayola bas (varsayılan **Ctrl + Alt + P**) — ya da linki kopyalarken **Ctrl + C**'ye art arda iki kez bas.
3. Seç: **biçim** → (MP4 ise) **kalite** → **klasör**. Rakam tuşlarıyla tek tuşta seçilebilir.
   Biçimler: MP3, MP4, M4A, Opus, FLAC, WAV.

İndirme sağ alt köşede görünür; bitince Windows bildirimi gelir, tıklayıp dosyayı açabilirsin.
Panel, inen bir şey kalmayınca 10 saniye sonra kapanır (fare üstündeyse beklemeye devam eder).

- İndirmeler sırayla yapılır: aynı anda bir tane iner, diğerleri sırada bekler.
- **İndirme geçmişi** ayrı bir pencerede açılır: paneldeki 🕘 düğmesi, Ayarlar ya da tepsi menüsünden.
  Aranabilir; dosyayı açma, klasörde gösterme ve tekrar indirme buradan yapılır.
- Ses dosyalarına (WAV hariç) videonun küçük resmi kapak olarak eklenir.
- Daha önce indirdiğin bir videoyu tekrar açarsan popup bunu söyler (biçim, tarih, klasör).
- Oynatma listelerinde ilerleme panelinde kaçıncı videoda olduğun görünür (ör. 3/25).
- Çift Ctrl+C ve bildirimler Ayarlar'dan kapatılabilir.

### Dosya paneli

Explorer'da dosya ya da klasör seç (bir veya birden fazla) ve **Ctrl + C**'ye art arda iki kez bas.
Kesmek için **Ctrl + X**'e iki kez basarsan panel "Taşı" modunda açılır; daha önce hiçbir yere taşımadıysan
klasör seçme penceresi doğrudan açılır.

- **Hedefler:** son kullanılan 5 klasör, Ayarlar'daki sabit klasörler (varsayılan Masaüstü, Belgeler, İndirilenler) ve takılı USB bellekler.
  **1–9** tuşları hedefi seçer, **Enter** en üsttekine gönderir, **S** klasör seçme penceresini açar, **Tab** kopyala/taşı arasında geçer.
- **Bulundukları yerde:** **Y** yeni klasöre topla · **A** türe göre ayır (Fotoğraflar, Videolar, Belgeler…) · **Z** ZIP yap ·
  **R** toplu yeniden adlandır (`tatil_01.jpg`, `tatil_02.jpg`…) · **P** dosya yollarını kopyala.
- Hiçbir şeyin üzerine yazılmaz: aynı adda dosya varsa `ad (2).uzantı` olarak kaydedilir.
- İşlem sağ altta görünür; **Geri al** ile son işlem geri alınır (tepsi menüsünden de). Kopyalar ve ZIP dosyaları
  geri alınırken kalıcı olarak silinmez, Geri Dönüşüm Kutusu'na gider.
- Ayarlar → Dosya paneli'nden kapatılabilir.

## Kurulum

Kurulum yok. [Releases](../../releases/latest) sayfasından `Pitaya-x.y.z-win-x64.zip` dosyasını indir, istediğin klasöre çıkar, `Pitaya.exe`'yi çalıştır.

- İlk açılışta gerekli araçları (yt-dlp, ffmpeg, Deno — toplam ~160 MB) bir kez indirir.
- Ayarlar ve araçlar exe'nin yanındaki `data` klasöründe durur; klasörü taşıyabilir ya da USB'ye kopyalayabilirsin.
- Windows ilk açılışta "Windows kişisel bilgisayarınızı korudu" diyebilir (uygulama imzalı değil): **Ek bilgi → Yine de çalıştır**.

## Güncellemeler

- **Pitaya** her açılışta ve 6 saatte bir GitHub Releases'ı kontrol eder, yeni sürümü indirip indirme yokken kendini yeniden başlatarak günceller.
- **yt-dlp** günde bir kez kendini günceller. Siteler değiştikçe indirme bozulmasın diye bu önemli.

## Geliştirme

```bash
npm install
npm start          # geliştirme modunda çalıştır
npm run icons      # assets/logo.svg'den ikonları üret
npm run dist       # dist/Pitaya-x.y.z-win-x64.zip oluştur
```

### Yeni sürüm yayınlama

Sürüm numarası etiketten alınır; `package.json`'u elle değiştirmek gerekmez.

```bash
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions uygulamayı derler ve zip'i Release olarak yayınlar. Kullanıcılardaki Pitaya birkaç saat içinde kendini günceller.

## Nasıl çalışır

| Parça | Görev |
|---|---|
| `src/main/main.js` | Tepsi simgesi, global kısayol, pencereler |
| `src/main/ytdlp.js` | Kaliteleri okuma, indirme ve ilerleme |
| `src/main/doublecopy.js` | Çift Ctrl+C'yi algılama (Windows pano sayacı, koffi ile) |
| `src/main/history.js` | İndirme geçmişi (Geçmiş penceresi ve "daha önce indirildi" uyarısı) |
| `src/main/components.js` | yt-dlp / ffmpeg / Deno'yu indirip güncel tutma |
| `src/main/updater.js` | GitHub Releases'tan kendini güncelleme |
| `src/renderer/` | Popup, ilerleme paneli ve ayarlar arayüzü |

Sorun olursa: Ayarlar → **Günlük dosyası**.
