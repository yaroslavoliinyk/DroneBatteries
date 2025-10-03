# FPV Batteries Inventory System

A comprehensive inventory management system for FPV drone batteries built with FastAPI (Python) backend and React frontend, using MongoDB for data storage.

## 🚀 Features

- **Balance Management**: Track deposits, withdrawals, and financial transactions
- **Parts Management**: Organize parts by classes and types with detailed specifications
- **Purchase Tracking**: Record purchases with vendor information and delivery status
- **Inventory Control**: Real-time inventory tracking with moving average cost calculation
- **Product Assembly**: Define products with Bill of Materials (BOM) and track assembly
- **Sales Management**: Record sales with customer information and pricing
- **Stock Management**: Track both raw materials and finished products

## 🏗️ Architecture

- **Backend**: FastAPI (Python) with MongoDB
- **Frontend**: React + Vite + Tailwind CSS
- **Database**: MongoDB Atlas
- **API**: RESTful API with CORS support

## 📁 Project Structure

```
DroneBatteries/
├── fpv-inventory-backend/          # FastAPI backend
│   ├── main.py                    # Main application file
│   └── requirements.txt           # Python dependencies
├── fpv-inventory-react-server/    # React frontend
│   ├── src/
│   │   ├── App.jsx               # Main React component
│   │   ├── api.js                # API client
│   │   ├── main.jsx               # React entry point
│   │   └── index.css              # Tailwind CSS
│   ├── package.json              # Node.js dependencies
│   ├── vite.config.js            # Vite configuration
│   └── tailwind.config.js        # Tailwind configuration
└── README.md                     # This file
```

## 🛠️ Setup Instructions

### Prerequisites

- Python 3.8+ with pip
- Node.js 16+ with npm
- MongoDB Atlas account (or local MongoDB)

### Backend Setup

1. **Navigate to backend directory:**
   ```bash
   cd fpv-inventory-backend
   ```

2. **Create virtual environment:**
   ```bash
   python -m venv .venv
   ```

3. **Activate virtual environment:**
   ```bash
   # On macOS/Linux:
   source .venv/bin/activate

   # On Windows:
   .venv\Scripts\activate
   ```

4. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

5. **Set up environment variables:**
   Create a `.env` file in the backend directory:
   ```env
   MONGODB_URI=mongodb+srv://root:4556@cluster0.a1fqoim.mongodb.net/
   DB_NAME=fpv_inventory
   FRONTEND_ORIGIN=http://localhost:5173
   ```

6. **Start the backend server:**
   ```bash
   uvicorn main:app --reload --port 8000
   ```

   The API will be available at `http://localhost:8000`

### Frontend Setup

1. **Navigate to frontend directory:**
   ```bash
   cd fpv-inventory-react-server
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create environment file (optional):**
   Create a `.env` file in the frontend directory:
   ```env
   VITE_API_BASE=http://localhost:8000
   ```

4. **Start the development server:**
   ```bash
   npm run dev
   ```

   The frontend will be available at `http://localhost:5173`

## 🗄️ Database Setup

### MongoDB Atlas (Recommended)

1. Create a MongoDB Atlas account at [mongodb.com](https://www.mongodb.com/cloud/atlas)
2. Create a new cluster
3. Get your connection string
4. Update the `MONGODB_URI` in your backend `.env` file

### Local MongoDB (Alternative)

1. Install MongoDB locally
2. Start MongoDB service
3. Set `MONGODB_URI=mongodb://localhost:27017` in your `.env` file

## 🚀 Running the Application

1. **Start the backend:**
   ```bash
   cd fpv-inventory-backend
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   uvicorn main:app --reload --port 8000
   ```

2. **Start the frontend (in a new terminal):**
   ```bash
   cd fpv-inventory-react-server
   npm run dev
   ```

3. **Access the application:**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:8000
   - API Documentation: http://localhost:8000/docs

## 📊 API Endpoints

The backend provides the following main endpoints:

- `GET /state` - Get complete application state
- `POST /balance/entries` - Add balance entry
- `GET /balance/value` - Get current balance
- `POST /parts/classes` - Add part class
- `POST /parts/types` - Add part type
- `POST /purchases` - Create purchase
- `POST /purchases/{id}/mark-delivered` - Mark purchase as delivered
- `POST /purchases/{id}/pay-from-balance` - Pay purchase from balance
- `POST /products` - Create product
- `POST /assembly` - Assemble product
- `POST /sales` - Create sale

## 🔧 Development

### Backend Development

- The backend uses FastAPI with automatic API documentation
- Database operations use Motor (async MongoDB driver)
- CORS is configured for frontend communication

### Frontend Development

- Built with React 18 and Vite for fast development
- Styled with Tailwind CSS
- Uses Lucide React for icons
- Responsive design for mobile and desktop

## 📝 Usage

1. **Setup Parts**: Start by adding part classes and types
2. **Manage Balance**: Add initial balance entries
3. **Record Purchases**: Create purchase orders and mark them as delivered
4. **Define Products**: Create products with their Bill of Materials
5. **Assemble Products**: Use available parts to assemble finished products
6. **Track Sales**: Record sales and manage customer information

## 🐛 Troubleshooting

### Common Issues

1. **CORS Errors**: Ensure the backend is running and CORS is properly configured
2. **Database Connection**: Verify MongoDB URI and network access
3. **Port Conflicts**: Make sure ports 8000 and 5173 are available

### Logs

- Backend logs: Check terminal where uvicorn is running
- Frontend logs: Check browser console and terminal where npm run dev is running

## 📄 License

This project is for internal use. All rights reserved.

## 🤝 Contributing

For any issues or feature requests, please contact the development team.