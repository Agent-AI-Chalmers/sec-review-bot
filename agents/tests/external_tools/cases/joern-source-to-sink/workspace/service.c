#include <stdlib.h>

void dangerous_eval(const char *value) {
    system(value);
}
