# Використовуємо офіційний Python образ
FROM python:3.11-slim

# Встановлюємо робочу директорію
WORKDIR /app

# Копіюємо файли залежностей
COPY requirements.txt .

# Встановлюємо Python залежності
RUN pip install --no-cache-dir -r requirements.txt

# Копіюємо код додатку
COPY . .

# Відкриваємо порт 8000
EXPOSE 8000

# Команда для запуску додатку
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
