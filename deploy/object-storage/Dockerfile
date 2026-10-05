FROM python:3.14-alpine@sha256:f6a589d43c42b9e7f7dc67a12d37132491f362859a5d750607710cc56da3bc72

RUN pip install --no-cache-dir boto3==1.43.108

COPY init.py /usr/local/bin/sec-review-object-storage-init

ENTRYPOINT ["python", "/usr/local/bin/sec-review-object-storage-init"]
