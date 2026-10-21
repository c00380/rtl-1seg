# libfec Viterbi27

`viterbi27_port.c`と`fec.h`は[quiet/libfec 9750ca0a6d0a786b506e44692776b541f90daa91](https://github.com/quiet/libfec/tree/9750ca0a6d0a786b506e44692776b541f90daa91)の原本です（Phil Karn、LGPL 2.1）。ライセンスは`../../licenses/libfec-LICENSE`。

`adapter.c`（GPL-3.0-or-later）はビット順、開始状態、信頼度の8bit変換（倍率64）、メトリック正規化、96段の連続履歴と終端なしのトレースバックを接続します。libfecの分岐計算・経路選択は変更していません。RS用ソース・APIは含めません。

JS側が履歴・入出力を確保し、連続受信では通常64KiBのメモリーを使用します。同期取得では必要に応じて拡張し、終了時に参照を解放します。履歴位置と充足数は固定範囲です。

`web`で`npm ci`後、`npm run build:viterbi`で`vendor/viterbi.js`を再生成します。固定版の`@yowasp/clang`がCをコンパイルし、WASMをJSへ埋め込みます。ブラウザーでの追加ダウンロードやコンパイラーは不要です。再リンク・変更にはこのソースと`build/viterbi.js`を利用できます。
