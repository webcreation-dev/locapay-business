import json
import urllib.request
import re
import html
import csv
import time
import os
import random

input_file = 'whatsapp_groups.json'
output_file = 'whatsapp_groups_extracted.csv'

def get_group_title(url):
    retries = 3
    for attempt in range(retries):
        try:
            # Randomizing the User-Agent slightly to look less like a bot
            req = urllib.request.Request(
                url, 
                headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
            )
            response = urllib.request.urlopen(req, timeout=10)
            html_content = response.read().decode('utf-8')
            
            title_match = re.search(r'<meta property=\"og:title\" content=\"(.*?)\"', html_content)
            if title_match:
                title = html.unescape(title_match.group(1))
                if title == 'WhatsApp Group Invite':
                    return 'Lien révoqué / Invalide'
                return title
                
            return 'Titre non trouvé'
            
        except urllib.error.HTTPError as e:
            if e.code == 429:
                if attempt < retries - 1:
                    wait_time = 60 * (attempt + 1)
                    print(f"\n[!] WhatsApp détecte qu'on va trop vite (Erreur 429). Pause de {wait_time} secondes...")
                    time.sleep(wait_time)
                    continue
                return 'Erreur HTTP 429 (Bloqué)'
            return f'Erreur HTTP {e.code}'
        except Exception as e:
            return f'Erreur: {str(e)}'

def main():
    print(f"Chargement des données depuis {input_file}...")
    with open(input_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # 1. On lit le CSV actuel pour savoir ce qui a DÉJÀ été fait avec succès
    processed_links = {}
    if os.path.exists(output_file):
        with open(output_file, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                # Si ça n'était PAS une erreur 429, on considère le lien comme traité
                if 'Erreur HTTP 429' not in row['nom_du_groupe']:
                    processed_links[row['whatsapp_link']] = row['nom_du_groupe']
                    
    total = len(data)
    # 2. On filtre pour ne garder que ceux qui ne sont pas encore traités
    to_process = [item for item in data if item['whatsapp_link'] not in processed_links]
    
    print(f"Total: {total} liens | Déjà traités avec succès: {len(processed_links)} | Restants à traiter: {len(to_process)}")

    if len(to_process) == 0:
        print("Il n'y a plus rien à traiter !")
        return

    # On ouvre le fichier en mode "Ajout" (append 'a') pour ne pas écraser les 300 premiers
    mode = 'a' if len(processed_links) > 0 else 'w'
    
    with open(output_file, mode, encoding='utf-8', newline='') as csvfile:
        fieldnames = ['whatsapp_link', 'nombre_de_publications', 'nom_du_groupe']
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        
        if mode == 'w':
            writer.writeheader()
        
        for idx, item in enumerate(to_process):
            link = item.get('whatsapp_link')
            count = item.get('nombre_de_publications')
            
            title = get_group_title(link)
            print(f"[{idx+1}/{len(to_process)}] {link} -> {title}")
            
            writer.writerow({
                'whatsapp_link': link,
                'nombre_de_publications': count,
                'nom_du_groupe': title
            })
            csvfile.flush()
            
            # Si malgré la pause de 60s, WhatsApp refuse encore, on arrête le script de force
            if 'Erreur HTTP 429' in title:
                print("\n[!!!] WhatsApp nous bloque de façon persistante. Le script s'arrête de lui-même.")
                print("Attendez 1 heure ou 2 avant de relancer le script (il reprendra là où il s'est arrêté).")
                break
                
            # Pause aléatoire entre 3 et 6 secondes pour ressembler à un humain
            time.sleep(random.uniform(3.0, 6.0))

    print(f"\nTerminé pour cette session ! Vérifiez votre fichier '{output_file}'.")

if __name__ == '__main__':
    main()
