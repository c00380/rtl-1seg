# EZPWD Reed-Solomon

固定ソースは[pjkundert/ezpwd-reed-solomon commit 62a490c13f6e057fbf2dc6777fde234c7a19098e](https://github.com/pjkundert/ezpwd-reed-solomon/tree/62a490c13f6e057fbf2dc6777fde234c7a19098e)です。`ezpwd/rs`・`ezpwd/rs_base`は原本で、ハッシュは`SOURCE.json`に記録しています。上流の[ライセンス案内](./ezpwd-LICENSE)・[GPLv3全文](./ezpwd-COPYING)を同梱します。`rs_base`のPhil Karn由来部分はLGPLで、既存の[LGPL-2.1全文](../libfec/libfec-LICENSE)も配布します。アダプターはGPL-3.0-or-laterです。

`adapter.cpp`はGF(256)、原始多項式0x11d、生成根0〜15、パリティ16バイトでEZPWDを初期化します。188バイトを符号化することで、RS(255,239)を先頭51バイト短縮したRS(204,188)になります。一般的な`RS<255,239>`の既定生成根1は使いません。符号化・訂正・パリティによる検査はライブラリが担当し、根0のXORによる早期棄却と、訂正した場合の再検査を接続します。JS側で入力をコピーし、返却用204バイト配列を再利用します。

`npm run build:rs`で`vendor/ezpwd.js`を再生成します。既存の`@yowasp/clang`を使い、例外・RTTI・標準ランタイムを含めず、メモリーを64KiBに固定してWASMを生成します。Moduleのコンパイルは共有し、Instanceと入出力は分離します。生成したWASMをJSへ埋め込むため、実行時の外部ダウンロードはありません。

ビルド時だけ、`EZPWD_NO_EXCEPTS`の致命的エラー用マクロを、標準エラー出力とabortから`__builtin_trap()`へ置き換えます。符号化・訂正アルゴリズムは変更しません。上流の原本は編集せず、`build/ezpwd.js`が原本のハッシュとマクロの一致を確認してから適用します。生成物は外部importを持たないことも検査します。このソース・アダプター・ビルドスクリプトから変更・再リンクできます。
