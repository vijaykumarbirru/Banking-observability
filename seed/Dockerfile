FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir httpx==0.28.1
WORKDIR /app
COPY seed.py .
RUN useradd -u 10001 app
USER app
CMD ["python", "seed.py"]
