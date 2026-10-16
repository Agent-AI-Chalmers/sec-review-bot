struct request {
    const char *token;
};

int validate_token(const char *token);

int authorize(struct request *request) {
    return validate_token(request->token);
}
