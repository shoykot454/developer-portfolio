# YouTube Shorts Downloader

একটা YouTube চ্যানেলের লিঙ্ক (বা `@handle`) দিন → চ্যানেলের সব Shorts দেখাবে →
একটা একটা করে, অথবা সিলেক্ট করে সবগুলো একসাথে **ZIP** হিসেবে ডাউনলোড করুন।

## ফিচার
- চ্যানেল লিঙ্ক চেনে: `youtube.com/@name`, `/channel/UC…`, `/c/name`, `/user/name`, শুধু `@name`, অথবা একটা `/shorts/…` লিঙ্ক
- থাম্বনেইল, টাইটেল, ভিউ, ডিউরেশনসহ সব Shorts-এর গ্রিড
- সিলেক্ট/আনসিলেক্ট, কোয়ালিটি বাছাই (Best / 720p / 480p / শুধু অডিও)
- একসাথে ডাউনলোডে লাইভ প্রোগ্রেস; কোনোটা ফেল করলে বাকিগুলো চলতে থাকে; শেষে ZIP
- মোবাইলে চলে

## চালানোর নিয়ম
দরকার: **Python 3.9+** আর **ffmpeg** (ভিডিও আর অডিও জোড়া লাগাতে লাগে)।

```bash
cd youtube-shorts-downloader
pip install -r requirements.txt
python app.py
```
তারপর ব্রাউজারে খুলুন: http://localhost:5000

ffmpeg ইনস্টল: Windows → `winget install ffmpeg`, macOS → `brew install ffmpeg`, Ubuntu → `sudo apt install ffmpeg`

## সেটিংস (environment variables)
| Variable | Default | কাজ |
|---|---|---|
| `PORT` | 5000 | সার্ভার পোর্ট |
| `MAX_SHORTS` | 500 | একটা চ্যানেল থেকে সর্বোচ্চ কতগুলো Shorts লিস্ট হবে |
| `MAX_PER_JOB` | 200 | একবারে সর্বোচ্চ কতগুলো ZIP-এ ডাউনলোড |
| `JOB_TTL_SECONDS` | 3600 | কতক্ষণ পর পুরনো ZIP মুছে যাবে |
| `DOWNLOAD_ROOT` | system temp | ফাইল কোথায় রাখা হবে |

## নোট
- YouTube মাঝে মাঝে নিয়ম বদলায়; ডাউনলোড বন্ধ হয়ে গেলে `pip install -U yt-dlp` দিয়ে আপডেট করুন।
- এটা ব্যক্তিগত/লোকাল ব্যবহারের জন্য বানানো। পাবলিক সার্ভারে দিলে YouTube সার্ভারের IP ব্লক করতে পারে, আর রেট-লিমিট/লগইন যোগ করা উচিত।
- শুধু নিজের কনটেন্ট বা যেগুলোর অনুমতি আছে সেগুলো ডাউনলোড করুন — কপিরাইট ও YouTube Terms মেনে চলুন।
