// ISDB-T RS(204,188) adapter, GPL-3.0-or-later.
// The codec owns all GF arithmetic, encoding and error correction.
#define EZPWD_NO_EXCEPTS
#include "ezpwd/rs"

using Codec = ezpwd::reed_solomon<uint8_t, 8, 16, 0, 1, ezpwd::gfpoly<8, 0x11d>, false>;
static Codec codec;
static uint8_t work[204], parity[16];

extern "C" {
unsigned rs_work() { return reinterpret_cast<unsigned>(work); }
int rs_encode() { return codec.encode(work, 188, work + 188); }
int rs_check() {
    // Root zero is the byte XOR: reject obvious non-codewords before re-encoding.
    uint8_t sum = 0;
    for (unsigned i = 0; i < 204; i++) sum ^= work[i];
    if (sum) return 0;
    codec.encode(work, 188, parity);
    return std::memcmp(work + 188, parity, 16) == 0;
}
int rs_decode() {
    const int corrected = codec.decode(work, 204);
    // Zero means the library already verified the received syndromes.
    // Recheck changed codewords against freshly encoded parity.
    return corrected == 0 ? 0 : corrected > 0 && rs_check() ? corrected : -1;
}
}
