# シフト家計簿

シフトボードのシフト（Googleカレンダー同期）から給与を自動計算し、収入・支出を入力して「来月締め日までに稼がないといけない金額」と「自由に使えるお金」を出すWebアプリです。データは自分のGoogle Driveに保存されます。

公開URL: https://hrtnmt.github.io/shift-money/

## 使い方
1. シフトボードの「カレンダー同期」をオンにし、Googleアカウントのカレンダーに同期
2. Google Cloud で OAuth クライアントID（ウェブアプリケーション）を作成し、承認済みのJavaScript生成元に `https://hrtnmt.github.io` を追加
3. `config.js` の `clientId` に貼り付けるか、アプリの「設定」に入力
