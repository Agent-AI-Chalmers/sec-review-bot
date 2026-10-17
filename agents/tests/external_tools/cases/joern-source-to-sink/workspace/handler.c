char *read_input(void);
void dangerous_eval(const char *value);

void evaluate_request(void) {
    char *value = read_input();
    dangerous_eval(value);
}
