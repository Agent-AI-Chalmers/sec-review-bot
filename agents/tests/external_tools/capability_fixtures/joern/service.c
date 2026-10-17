#include <stdlib.h>
#include <string.h>

int validate_token(const char *token) {
    return strcmp(token, "trusted") == 0;
}

void dangerous_eval(const char *value) {
    system(value);
}
