/* Continuous ISDB-T adapter, GPL-3.0-or-later.
 * The included libfec portable butterfly is unmodified (LGPL-2.1).
 * History and I/O live in memory sized by the JS owner; there is no C heap.
 */
#include <stddef.h>
unsigned char Partab[256];
int P_init;
void partab_init(void) {
  for (unsigned i = 0; i < 256; i++) Partab[i] = __builtin_parity(i);
  P_init = 1;
}
#include "viterbi27_port.c"
_Static_assert(sizeof(decision_t) == 8, "Viterbi history must use two 32-bit words");

#define EXPORT(name) __attribute__((export_name(name)))
static struct v27 decoder;
static float *input;
static unsigned char *output;
static unsigned char reversed[64];
static unsigned depth, filled, cursor;

EXPORT("configure") void configure(decision_t *history, float *soft, unsigned char *bits) {
  decoder.decisions = history;
  input = soft;
  output = bits;
}
static void reset(void) {
  init_viterbi27_port(&decoder, 0);
  for (unsigned i = 1; i < 64; i++) decoder.old_metrics->w[i] = 0x3fffffff;
  filled = cursor = 0;
}
EXPORT("init") void initialize(unsigned d) {
  int polys[2] = {0x4f, 0x6d}; /* 0171/0133 reversed for libfec's left shift */
  set_viterbi27_polynomial_port(polys);
  for (unsigned i = 0; i < 64; i++) {
    unsigned x = i, y = 0;
    for (unsigned j = 0; j < 6; j++, x >>= 1) y = (y << 1) | (x & 1);
    reversed[i] = y;
  }
  depth = d;
  reset();
}
static unsigned char quantize(float x) {
  float y = 127.5f + 64.0f * x;
  return y <= 0 ? 0 : y >= 255 ? 255 : (unsigned char)(y + 0.5f);
}
static unsigned advance(float x, float y, unsigned slot) {
  unsigned char symbols[2] = {quantize(x), quantize(y)};
  decoder.dp = decoder.decisions + slot;
  update_viterbi27_blk_port(&decoder, symbols, 1);
  unsigned best = 0, minimum = decoder.old_metrics->w[0];
  for (unsigned i = 1; i < 64; i++) {
    unsigned metric = decoder.old_metrics->w[i];
    if (metric < minimum || (metric == minimum && reversed[i] > reversed[best])) {
      minimum = metric;
      best = i;
    }
  }
  for (unsigned i = 0; i < 64; i++) decoder.old_metrics->w[i] -= minimum;
  return best;
}
static unsigned predecessor(unsigned state, unsigned slot) {
  unsigned decision = (decoder.decisions[slot].w[state >> 5] >> (state & 31)) & 1;
  return (state >> 1) | (decision << 5);
}
EXPORT("push") unsigned push(unsigned count) {
  unsigned n = 0;
  for (unsigned i = 0; i < count; i++) {
    unsigned state = advance(input[2*i], input[2*i+1], cursor);
    unsigned slot = cursor;
    if (++cursor == depth) cursor = 0;
    if (filled < depth) filled++;
    if (filled < depth) continue;
    unsigned bit = 0;
    for (unsigned j = 0; j < depth; j++) {
      bit = state & 1;
      state = predecessor(state, slot);
      slot = slot ? slot - 1 : depth - 1;
    }
    output[n++] = bit;
  }
  return n;
}
EXPORT("decode") void decode(unsigned count) {
  reset();
  unsigned state = 0;
  for (unsigned i = 0; i < count; i++) state = advance(input[2*i], input[2*i+1], i);
  for (unsigned i = count; i-- > 0;) {
    output[i] = state & 1;
    state = predecessor(state, i);
  }
  reset();
}
