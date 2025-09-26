*backend*
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

*frontend*
npm install
npm run dev

*DB*
mongosh mongodb+srv://root:4556@cluster0.a1fqoim.mongodb.net/