import csv
import re

input_file = "whatsapp_groups_extracted.csv"
output_file = "whatsapp_groups_immobilier.csv"

keywords = [
    "immo", "logement", "chambre", "appartement", "studio", "villa", "location", 
    "louer", "vente", "achat", "terrain", "parcelle", "domaine", "habitat", 
    "agence", "maison", "duplex", "boutique", "magasin", "bureau", "parcelles",
    "propriété", "foncier", "résidence", "promoteur", "courtier", "guérite",
    "locataire", "propriétaire", "loyer", "bail", "caution", "colocation", "loger", "hébergement"
]

def is_immobilier(group_name):
    if not group_name or str(group_name).strip() == "":
        return False
        
    group_name_lower = str(group_name).lower()
    for kw in keywords:
        if kw in group_name_lower:
            return True
    return False

kept_count = 0
total_count = 0

with open(input_file, mode='r', encoding='utf-8') as infile, \
     open(output_file, mode='w', encoding='utf-8', newline='') as outfile:
    
    reader = csv.DictReader(infile)
    writer = csv.DictWriter(outfile, fieldnames=reader.fieldnames)
    writer.writeheader()
    
    for row in reader:
        total_count += 1
        name = row.get("nom_du_groupe", "").strip()
        if is_immobilier(name):
            writer.writerow(row)
            kept_count += 1

print(f"Filtrage terminé !")
print(f"Groupes initiaux : {total_count}")
print(f"Groupes conservés : {kept_count}")
print(f"Groupes éliminés : {total_count - kept_count}")
print(f"Nouveau fichier sauvegardé : {output_file}")
