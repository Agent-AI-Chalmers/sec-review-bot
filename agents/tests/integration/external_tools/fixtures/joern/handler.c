struct request {
    const char *token;
    const char *query;
};

int validate_token(const char *token);
void dangerous_eval(const char *value);
char *read_input(void);

int authorize(struct request *request) {
    return validate_token(request->token);
}

void evaluate_request(void) {
    char *value = read_input();
    dangerous_eval(value);
}
