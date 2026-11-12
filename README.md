# 工具集

常用小工具的入口頁：依分類瀏覽或直接搜尋，點卡牌就能使用。純靜態網站，無後端。

## 新增或修改工具

只要編輯 [`tools.json`](tools.json)：

```json
{
  "id": "unique-id",
  "name": "工具名稱",
  "desc": "一句話說明用途（建議 30 字內）",
  "category": "media",
  "tags": ["關鍵字", "也會被搜尋"],
  "url": "https://工具網址/",
  "icon": "🔧"
}
```

`category` 必須是 `categories` 裡的其中一個 `id`；要新分類就在 `categories` 加一筆。
Commit 推上 `main` 後，GitHub Pages 會自動更新。

## 功能

- 搜尋：比對名稱、簡介、分類與標籤，即時篩選並高亮；按 `/` 聚焦搜尋框，`Esc` 清除。
- 分類：顯示每類數量，可與搜尋同時使用。
- 狀態在網址上（`?q=…&cat=…`），可直接分享篩選結果。
- 支援手機版面與深色模式。

## 本機預覽

```bash
python3 -m http.server 8767
```

再開啟 http://localhost:8767 （`tools.json` 以 fetch 載入，需經由 http）。
