#!/bin/bash

# Voice Chat Room - Quick Setup Script
# Run: chmod +x setup.sh && ./setup.sh

set -e

echo "🎤 Voice Chat Room - Setup"
echo "============================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Install from https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js $(node --version)"
echo "✅ npm $(npm --version)"
echo ""

# Check if already installed
if [ -d "node_modules" ]; then
    echo "✅ Dependencies already installed"
    read -p "Reinstall? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        skip_install=true
    fi
fi

# Install dependencies
if [ "$skip_install" != true ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo "✅ Dependencies installed"
fi

echo ""

# Check .env file
if [ ! -f ".env" ]; then
    echo "🔧 Creating .env file..."
    
    # Generate secure password
    if command -v openssl &> /dev/null; then
        PASSWORD=$(openssl rand -base64 12)
    else
        PASSWORD=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 16)
    fi
    
    cat > .env << EOF
SERVER_PASSWORD=$PASSWORD
PORT=3000

# Optional TURN server config
# TURN_URL=turn:your-turn-server.com:3478
# TURN_USERNAME=username
# TURN_CREDENTIAL=credential
EOF
    
    echo "✅ .env created"
    echo "   Password: $PASSWORD"
    echo ""
    echo "⚠️  Save this password securely!"
    echo "    Edit .env to change it later"
else
    echo "✅ .env already exists"
    PASSWORD=$(grep SERVER_PASSWORD .env | cut -d'=' -f2)
    echo "   Current password: $PASSWORD"
fi

echo ""
echo "✨ Setup complete!"
echo ""
echo "📍 To start the server:"
echo "   npm start"
echo ""
echo "🌐 Then open:"
echo "   http://localhost:3000"
echo ""
echo "🔑 Room password:"
echo "   $PASSWORD"
echo ""
echo "📚 Documentation:"
echo "   - README.md - Full guide"
echo "   - RASPBERRY_PI_GUIDE.md - For Pi deployment"
echo "   - TURN_SERVER_SETUP.md - For NAT traversal"
echo ""
