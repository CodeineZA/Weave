from flask import Flask, jsonify
import random

app = Flask(__name__)

GAMES = [
    "Minecraft",
    "Valorant",
    "League of Legends",
    "Among Us",
    "Jackbox Party Pack",
    "Terraria"
]

@app.route('/spin', methods=['GET', 'POST'])
def spin_wheel():
    chosen_game = random.choice(GAMES)
    return jsonify({
        "message": f"🎡 The wheel spins... and lands on: **{chosen_game}**!"
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)