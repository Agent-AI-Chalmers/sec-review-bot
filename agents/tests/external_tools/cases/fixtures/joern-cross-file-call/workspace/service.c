#include <string.h>

int validate_token(const char *token) {
    return strcmp(token, "trusted") == 0;
}
